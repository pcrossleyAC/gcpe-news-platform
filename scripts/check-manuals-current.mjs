// CI check: a pull request that changes a Hub screen must also update the manual page that describes
// it. Pure rule in missingManualUpdates; the CLI feeds it git's view of the pull request.
// Usage: node scripts/check-manuals-current.mjs --base origin/main
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePage } from "./manuals-lib.mjs";

export const OPT_OUT = "Manual: no change";
const SCREENS = "apps/staff-web/src/screens/";
const MANUALS = "docs/manuals/";

/** True when `file` is a page: a .md inside a folder of docs/manuals/ (not directly in docs/manuals/). */
const isPagePath = (file) => file.startsWith(MANUALS) && file.endsWith(".md") && file.indexOf("/", MANUALS.length) !== -1;

/**
 * One message per screen folder whose files changed while no page naming it changed.
 * changedFiles: paths from `git diff --name-only` (added, changed and deleted).
 * pages: { id, path, screens } for the pages as they are now, plus any page deleted in this change
 *   (its header read from the base) so that a deletion counts as a change to the pages naming that folder.
 * commitMessages: full messages; a line exactly `Manual: no change` exempts the whole pull request.
 * A folder matches exactly, or as a prefix at a folder boundary (admin/organizations covers admin/organizations/sub/x.tsx,
 * not admin/organizations-x/). Each file belongs only to the narrowest named folder that covers it: with pages naming
 * website and website/settings, website/settings/x.tsx is checked against the website/settings pages alone.
 */
export function missingManualUpdates(changedFiles, pages, commitMessages) {
  if (commitMessages.some((m) => m.split(/\r?\n/).some((line) => line.trimEnd() === OPT_OUT))) return [];
  const changed = new Set(changedFiles);
  const screenFiles = changedFiles.filter((f) => f.startsWith(SCREENS) && !/\.test\.[^/]*$/.test(f.slice(f.lastIndexOf("/") + 1)));
  const named = [...new Set(pages.flatMap((p) => p.screens))].sort();
  const owner = (file) => named.filter((folder) => file.startsWith(`${SCREENS}${folder}/`)).sort((a, b) => b.length - a.length)[0];
  const messages = [];
  for (const folder of named) {
    const touched = screenFiles.filter((f) => owner(f) === folder);
    if (touched.length === 0) continue;
    const covering = pages.filter((p) => p.screens.includes(folder));
    if (covering.some((p) => changed.has(p.path))) continue;
    const ids = covering.map((p) => p.id).sort();
    messages.push(
      `You changed the screen folder ${folder} (${touched[0]}${touched.length > 1 ? ` and ${touched.length - 1} more` : ""}) but not its manual. ` +
        `Update ${ids.length > 1 ? "one of these manual pages" : "this manual page"}: ${ids.join(", ")}. ` +
        `If the change does not affect what staff see or do, add a line to a commit message saying exactly: ${OPT_OUT}`,
    );
  }
  return messages;
}

const git = (...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every page under docs/manuals/<folder>/ of the repository in the current directory. */
function readPages() {
  const pages = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, depth + 1);
      else if (depth > 0 && e.name.endsWith(".md")) {
        const { header } = parsePage(rel, readFileSync(join(process.cwd(), rel), "utf8"));
        pages.push({ id: header.id, path: rel, screens: header.screens });
      }
    }
  };
  walk("docs/manuals", 0);
  return pages;
}

function main(argv) {
  const i = argv.indexOf("--base");
  const base = i !== -1 ? argv[i + 1] : undefined;
  if (!base) {
    console.error("Usage: node scripts/check-manuals-current.mjs --base <ref>   (for example --base origin/main)");
    return 2;
  }
  // Compare with where this branch left the base, not the base's tip: the base may have moved on.
  const mergeBase = git("merge-base", base, "HEAD").trim();
  // -z and no quotepath keep non-ASCII names intact; --no-renames lists the old path of a moved file as deleted.
  const changedFiles = git("diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`).split("\0").filter(Boolean);
  const commitMessages = git("log", "--format=%B%x00", `${base}..HEAD`).split("\0").filter((m) => m.trim());
  const pages = readPages();
  // A page deleted in this change no longer exists to read; take its header from the merge base.
  const current = new Set(pages.map((p) => p.path));
  for (const path of changedFiles.filter((f) => isPagePath(f) && !current.has(f))) {
    try {
      const { header } = parsePage(path, git("show", `${mergeBase}:${path}`));
      pages.push({ id: header.id, path, screens: header.screens });
    } catch (err) {
      console.error(`Could not read the deleted page ${path} from ${mergeBase}: ${err.message}`);
    }
  }
  const messages = missingManualUpdates(changedFiles, pages, commitMessages);
  for (const m of messages) console.error(m);
  return messages.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
