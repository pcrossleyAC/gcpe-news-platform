// Builds the Windows Server package (docs/deploy/windows.md): one folder, zipped, that a developer
// copies to the server and installs with deploy/windows/Install-Gcpe.ps1.
//
//   dist/windows/gcpe-windows/          the package
//     *.ps1, lib/                       deploy/windows/ (installer, DMZ proxy, deploy, import, runner scripts)
//     app/                              one release: dist/siteground/ (stack.js, hub/, migrations/,
//                                       config/, report worker) plus the command-line tools below
//     prereqs/pgvector/                 only when --pgvector <dir> is given (CI builds it on Windows)
//   dist/gcpe-windows-<sha>.zip         the same folder, zipped
//   dist/gcpe-proxy-<sha>.zip           the DMZ proxy's package: Install-GcpeProxy.ps1, Get-GcpePrereqs.ps1
//                                       and lib/ only (no app, nothing secret)
//
// The tools are each bundled to the same relative path as their source entry (apps/nrms/src/import/
// cli.ts -> app/apps/nrms/src/import/cli.js) beside a copy of that app's migrations, so the paths
// they compute from their own import.meta.url (migrations, config/tenants/bc.json) resolve inside
// the release exactly as they do in the repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist/windows/gcpe-windows");
const appDir = join(outDir, "app");

/** Entry points bundled as tools: the legacy importers and the post-import commands. */
export const TOOLS = [
  "apps/core/src/import/cli.ts",
  "apps/news-api/src/import/cli.ts",
  "apps/nrms/src/import/cli.ts",
  "apps/nod/src/import/cli.ts",
  "apps/calendar/src/import/cli.ts",
  "apps/nrms/src/cli/replay-to-news-api.ts",
  "apps/nrms/src/cli/release-holds.ts",
  "apps/public-site/src/cli/rebuild-all.ts",
  "apps/public-site/src/cli/precompress.ts",
  "apps/news-api/src/cli/search-backfill.ts",
  "scripts/windows-env.ts",
  "scripts/windows-db-setup.ts",
  // A fresh break-glass password hash, for turning break-glass on in an emergency (windows.md P4).
  "packages/auth/src/cli/hash-password.ts",
];

/** What the DMZ proxy's package holds (deploy/windows/), and nothing else. */
export const PROXY_FILES = ["Install-GcpeProxy.ps1", "Get-GcpePrereqs.ps1", "lib"];

/** Source files that run their own main() when they are the process entry point (see TOOLS). */
const ENTRY_GUARD = /\.href === import\.meta\.url|import\.meta\.url === pathToFileURL/;

/**
 * Bundling flattens every module's import.meta.url to the bundle's own, so a second guarded
 * module inside one bundle would also see itself as the entry point and run its main() too.
 * Returns the guarded inputs of a bundle other than its own entry.
 */
export function extraEntryGuards(metafile, entry, read = (p) => readFileSync(join(root, p), "utf8")) {
  return Object.keys(metafile.inputs).filter((p) => p !== entry && !p.includes("node_modules") && /\.(ts|mjs|js)$/.test(p) && ENTRY_GUARD.test(read(p)));
}

async function bundleTool(entry) {
  const outfile = join(appDir, entry.replace(/\.ts$/, ".js"));
  const result = await build({
    entryPoints: [join(root, entry)],
    absWorkingDir: root,
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["pg-native", "bufferutil", "utf-8-validate"],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    // Not minified: an importer's crash prints the offending source line, and minified that is one
    // line of the whole bundle.
    keepNames: true,
    metafile: true,
    logLevel: "warning",
  });
  const extra = extraEntryGuards(result.metafile, entry);
  if (extra.length > 0) throw new Error(`${entry}: bundles another entry point (${extra.join(", ")}), whose main() would run too`);
  const app = /^apps\/([^/]+)\//.exec(entry)?.[1];
  if (app) cpSync(join(root, "apps", app, "migrations"), join(appDir, "apps", app, "migrations"), { recursive: true });
}

function parseArgs(argv) {
  const at = argv.indexOf("--pgvector");
  return { pgvectorDir: at === -1 ? null : resolve(argv[at + 1]) };
}

async function runBuild() {
  const { pgvectorDir } = parseArgs(process.argv.slice(2));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

  console.log("[build-windows] building the stack artifact (scripts/build-siteground.mjs) …");
  execFileSync(process.execPath, [join(root, "scripts/build-siteground.mjs")], { cwd: root, stdio: "inherit" });

  rmSync(join(root, "dist/windows"), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(root, "dist/siteground"), appDir, { recursive: true });
  // The SiteGround README describes that host; the package's own README.md replaces it.
  rmSync(join(appDir, "README.txt"), { force: true });

  console.log("[build-windows] bundling the command-line tools …");
  for (const entry of TOOLS) await bundleTool(entry);

  console.log("[build-windows] copying deploy/windows …");
  cpSync(join(root, "deploy/windows"), outDir, { recursive: true });
  if (pgvectorDir) {
    if (!existsSync(join(pgvectorDir, "vector.dll"))) throw new Error(`--pgvector ${pgvectorDir}: no vector.dll there`);
    cpSync(pgvectorDir, join(outDir, "prereqs/pgvector"), { recursive: true });
  }
  writeFileSync(join(appDir, "VERSION.json"), JSON.stringify({ commit: sha, builtAt: new Date().toISOString() }, null, 2) + "\n");

  const zip = join(root, "dist", `gcpe-windows-${sha.slice(0, 12)}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "gcpe-windows"], { cwd: join(root, "dist/windows"), stdio: "inherit" });
  console.log(`[build-windows] OK — ${zip}`);

  // The DMZ server gets only what Install-GcpeProxy.ps1 uses: never the app or its tools.
  const proxyRoot = join(root, "dist/windows-proxy");
  const proxyDir = join(proxyRoot, "gcpe-proxy");
  rmSync(proxyRoot, { recursive: true, force: true });
  mkdirSync(proxyDir, { recursive: true });
  for (const f of PROXY_FILES) cpSync(join(root, "deploy/windows", f), join(proxyDir, f), { recursive: true });
  writeFileSync(join(proxyDir, "VERSION.json"), JSON.stringify({ commit: sha, builtAt: new Date().toISOString() }, null, 2) + "\n");
  writeFileSync(
    join(proxyDir, "README.txt"),
    "GCPE News Platform - DMZ reverse proxy package. Runbook: docs/deploy/windows.md, section 4 (T3).\r\n" +
      "No internet on this server? On a machine that has it: .\\Get-GcpePrereqs.ps1 -Names UrlRewrite, Arr\r\n" +
      "Then: .\\Install-GcpeProxy.ps1 (Get-Help .\\Install-GcpeProxy.ps1 -Full). Delete this folder after the install.\r\n",
  );
  const proxyZip = join(root, "dist", `gcpe-proxy-${sha.slice(0, 12)}.zip`);
  rmSync(proxyZip, { force: true });
  execFileSync("zip", ["-qr", proxyZip, "gcpe-proxy"], { cwd: proxyRoot, stdio: "inherit" });
  console.log(`[build-windows] OK — ${proxyZip}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBuild();
}
