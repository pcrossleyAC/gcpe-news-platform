// Compiles docs/manuals/**/*.md into apps/staff-web/src/manuals/manuals.generated.json.
// Usage: npm run manuals:build   (commit the result; the freshness test fails when it is stale)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, readManualPages, vancouverToday } from "./manuals-lib.mjs";

const out = join(import.meta.dirname, "../apps/staff-web/src/manuals/manuals.generated.json");
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const data = compile(readManualPages(), previous, vancouverToday());
writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
console.log(`manuals: wrote ${data.pages.length} page(s) to apps/staff-web/src/manuals/manuals.generated.json`);
