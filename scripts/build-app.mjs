// Usage: node scripts/build-app.mjs apps/<name>
// Bundles the app and its @gcpe/* workspace packages into dist/main.js; npm dependencies stay external.
import { build } from "esbuild";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appDir = resolve(root, process.argv[2] ?? ".");
const deps = new Set();
const addDeps = (pkgPath) => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const name of Object.keys(pkg.dependencies ?? {})) if (!name.startsWith("@gcpe/")) deps.add(name);
};
addDeps(join(appDir, "package.json"));
for (const dir of readdirSync(join(root, "packages"))) {
  const p = join(root, "packages", dir, "package.json");
  if (existsSync(p)) addDeps(p);
}
await build({
  entryPoints: [join(appDir, "src/main.ts")],
  outfile: join(appDir, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: [...deps],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log(`built ${appDir}/dist/main.js`);
