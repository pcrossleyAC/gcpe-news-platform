// Compiles docs/manuals/**/*.md into apps/staff-web/src/manuals/: manuals.generated.json (every
// field; the Word build and the next compile read it), manuals.hub.generated.json (what the Hub's
// main bundle imports: no markdown, no previous versions) and manuals.previous.generated.json (the
// previous versions, which the review screen loads on its own).
// Usage: npm run manuals:build   (commit the results; the freshness test fails when they are stale)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, readManualPages, splitForHub, vancouverToday } from "./manuals-lib.mjs";

const dir = join(import.meta.dirname, "../apps/staff-web/src/manuals");
const out = join(dir, "manuals.generated.json");
const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n");
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const data = compile(readManualPages(), previous, vancouverToday());
const split = splitForHub(data);
write("manuals.generated.json", data);
write("manuals.hub.generated.json", split.hub);
write("manuals.previous.generated.json", split.previous);
console.log(`manuals: wrote ${data.pages.length} page(s) to apps/staff-web/src/manuals/manuals{,.hub,.previous}.generated.json`);
