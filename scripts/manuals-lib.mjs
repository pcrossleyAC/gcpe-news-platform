// Staff manuals: the page format and the compiler. Pure functions (plus readManualPages, which reads
// docs/manuals/) shared by scripts/manuals-build.mjs and the tests in apps/staff-web/src/manuals/, so
// the CLI and the freshness test compile the same way. See docs/manuals/README.md for the page format.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Marked } from "marked";

export const MANUAL_IDS = [
  "core-admin",
  "nrms-site-editor",
  "nrms-editor",
  "nrms-viewer",
  "nod-admin",
  "nod-editor",
  "nod-viewer",
  "calendar-admin",
  "calendar-advanced",
  "calendar-editor",
  "calendar-readonly",
];

const FIELDS = {
  id: "string",
  title: "string",
  manual: "string",
  order: "number",
  routes: "list",
  screens: "list",
  topics: "list",
};

const root = join(import.meta.dirname, "..");
export const MANUALS_DIR = join(root, "docs/manuals");

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function parseValue(path, key, raw, kind) {
  const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (kind === "list") {
    const m = /^\[(.*)\]$/.exec(raw.trim());
    if (!m) fail(path, `"${key}" must be a list in square brackets, like [a, b] or []`);
    return m[1].trim() === "" ? [] : m[1].split(",").map(unquote);
  }
  if (kind === "number") {
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n)) fail(path, `"${key}" must be a number`);
    return n;
  }
  const v = unquote(raw);
  if (v === "") fail(path, `"${key}" must not be empty`);
  return v;
}

/** Splits a page into its YAML-style header (flat `key: value` lines) and its Markdown body. */
export function parsePage(path, text) {
  text = text.replace(/\r\n/g, "\n");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) fail(path, "the page must start with a header between --- lines");
  const raw = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) fail(path, `cannot read header line "${line}"`);
    const [, key, value] = kv;
    if (!(key in FIELDS)) fail(path, `unknown header field "${key}"`);
    if (key in raw) fail(path, `header field "${key}" appears twice`);
    raw[key] = value;
  }
  const header = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    if (!(key in raw)) fail(path, `missing header field "${key}"`);
    header[key] = parseValue(path, key, raw[key], kind);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(header.id)) fail(path, `id "${header.id}" must be lower-case words joined by hyphens`);
  if (header.manual !== "topic" && !MANUAL_IDS.includes(header.manual)) fail(path, `unknown manual "${header.manual}"`);
  return { header, body: m[2] };
}

// Raw HTML in a page is shown as text, never rendered: pages are written by staff, not trusted markup.
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Links and images may only point to http, https, mailto, the manual:/topic: schemes (Hub-internal
// links, resolved by the Hub) or a relative address. Anything else (javascript:, data:, //host ...)
// is shown as plain text, because the Hub injects this html into the page.
const NAMED_REFS = { colon: ":", tab: "\t", newline: "\n", nbsp: "\u00a0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", sol: "/", bsol: "\\", lpar: "(", rpar: ")" };
const ENTITY = /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*);)/g;

// Browsers decode character references in an href before using it, so the check must see the decoded text.
function decodeRefs(raw) {
  return raw.replace(ENTITY, (whole, dec, hex, name) => {
    if (name) return NAMED_REFS[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function safeTarget(href) {
  const decoded = decodeRefs(href).replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, "");
  if (/^[/\\]{2}/.test(decoded) || decoded.startsWith("/\\") || decoded.startsWith("\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded);
  if (scheme) return ["http", "https", "mailto", "manual", "topic"].includes(scheme[1].toLowerCase());
  return !href.includes(":") && !/&(?:#|[A-Za-z][A-Za-z0-9]*;)/.test(href);
}
// Set by compile() while it renders one page: turns a manual:/topic: target into a Hub route
// (or throws). Without one (renderMarkdown on its own) such targets are left as written.
let resolveInternal = null;

const INTERNAL = /^(manual|topic):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The Hub address for a `manual:` or `topic:` target; the Hub is mounted at /hub/. Throws if it points nowhere. */
function internalRoute(target, headers) {
  const m = INTERNAL.exec(target);
  if (!m) throw new Error(`link "${target}" is not valid: write manual:<page id>, manual:<manual id> or topic:<topic id>`);
  const [, kind, id] = m;
  const page = headers.find((h) => h.id === id);
  if (kind === "topic") {
    if (!page || page.manual !== "topic") throw new Error(`link "${target}" does not match a topic page`);
    return `/hub/help/manuals/topic/${id}`;
  }
  if (page && page.manual !== "topic") return `/hub/help/manuals/${page.manual}/${id}`;
  if (MANUAL_IDS.includes(id)) return `/hub/help/manuals/${id}`;
  throw new Error(`link "${target}" does not match a manual page or a manual`);
}

const marked = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link(token) {
      if (!safeTarget(token.href)) return this.parser.parseInline(token.tokens);
      if (resolveInternal) {
        const target = decodeRefs(token.href).trim();
        if (/^(manual|topic):/i.test(target)) token.href = resolveInternal(target);
      }
      return false;
    },
    image(token) {
      // Images may not point at manual:/topic: (those are page links, not pictures).
      return safeTarget(token.href) && !/^(manual|topic):/i.test(decodeRefs(token.href).trim()) ? false : escapeHtml(token.text);
    },
  },
  hooks: {
    // A table or code block wider than the screen scrolls inside its own labelled, focusable box
    // (as shared/TableScroll does), not the whole page. Raw HTML in a page is escaped, so every
    // <table> and <pre> here was made by the renderer.
    postprocess(html) {
      const wrap = (name, label) => {
        let n = 0;
        html = html.replace(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, "g"), (block) => {
          n += 1;
          return `<div class="gcpe-table-scroll" role="region" aria-label="${label} ${n} — scrollable" tabindex="0">${block}</div>`;
        });
      };
      wrap("table", "Table");
      wrap("pre", "Code");
      return html;
    },
  },
});

export function renderMarkdown(markdown, resolve = null) {
  resolveInternal = resolve;
  try {
    return marked.parse(markdown, { async: false });
  } finally {
    resolveInternal = null;
  }
}

const hashOf = (header, body) =>
  createHash("sha256")
    .update(JSON.stringify(header) + "\n" + body)
    .digest("hex");

/**
 * pages: [{ path, text }]. previousData: the last committed ManualsData, or null.
 * A page whose hash is unchanged keeps its `changed` date and `previous`; an edited page gets
 * changed = today and previous = its old html and date. Pages missing from the input are dropped.
 */
export function compile(pages, previousData, today) {
  const old = new Map((previousData?.pages ?? []).map((p) => [p.id, p]));
  const seen = new Map();
  const parsed = [];
  for (const { path, text } of pages) {
    const { header, body } = parsePage(path, text);
    if (seen.has(header.id)) fail(path, `duplicate id "${header.id}", already used by ${seen.get(header.id)}`);
    seen.set(header.id, path);
    parsed.push({ path, header, body });
  }
  const headers = parsed.map((p) => p.header);
  const out = [];
  for (const { path, header, body } of parsed) {
    const hash = hashOf(header, body);
    const html = renderMarkdown(body, (target) => {
      try {
        return internalRoute(target, headers);
      } catch (e) {
        return fail(path, e.message);
      }
    });
    const prev = old.get(header.id);
    let changed = today;
    let previous = null;
    if (prev && prev.hash === hash) {
      changed = prev.changed;
      previous = prev.previous;
    } else if (prev) {
      previous = { html: prev.html, changed: prev.changed };
    }
    out.push({ ...header, markdown: body, html, hash, changed, previous });
  }
  const rank = (p) => (p.manual === "topic" ? MANUAL_IDS.length : MANUAL_IDS.indexOf(p.manual));
  out.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id));
  return { pages: out };
}

/**
 * What the Hub ships, split out of the full compiled data so its main bundle stays small: `hub` is
 * every page without `markdown` (only the Word build reads it) or `previous` (only the review
 * screen shows it); `previous` maps each page id to its previous version, loaded on its own.
 */
export function splitForHub(data) {
  return {
    hub: { pages: data.pages.map(({ markdown: _markdown, previous: _previous, ...page }) => page) },
    previous: Object.fromEntries(data.pages.map((p) => [p.id, p.previous])),
  };
}

/** Every page under docs/manuals/<folder>/ (the README and loose notes at the top level are not pages). */
export function readManualPages(dir = MANUALS_DIR) {
  const files = [];
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (depth > 0 && e.name.endsWith(".md")) files.push(p);
    }
  };
  walk(dir, 0);
  return files.map((f) => ({ path: relative(root, f).split("\\").join("/"), text: readFileSync(f, "utf8") }));
}

/** Today's calendar date in British Columbia, as YYYY-MM-DD. */
export function vancouverToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const BANNED_WORDS = ["database", "endpoint", "JSON", "SQL", "payload", "boolean", "null"];

/** The plain-language rules for a page body. Returns a list of problems; empty means it passes. */
export function plainLanguageProblems(body) {
  const problems = [];
  const lines = body.split(/\r?\n/);
  let fenced = false;
  let heading = null;
  let firstParagraphDone = true;
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const isWho = line.startsWith("**Who this is for:**");
    if (line.includes("/api/")) problems.push(`${at}: contains an API path ("/api/")`);
    if (!isWho) {
      const role = /\b(Core|NRMS|NoD|Calendar)\.[A-Z][A-Za-z]*/.exec(line);
      if (role) problems.push(`${at}: role id "${role[0]}" belongs only on the "Who this is for" line`);
    }
    for (const w of BANNED_WORDS) {
      if (new RegExp(`\\b${w}s?\\b`, "i").test(line)) problems.push(`${at}: contains the word "${w}"`);
    }
    if (fenced) return;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1].toLowerCase();
      firstParagraphDone = false;
    } else if (!firstParagraphDone && line.trim() !== "") {
      firstParagraphDone = true;
      if (heading && line.trim().toLowerCase().startsWith(heading)) problems.push(`${at}: repeats the heading "${heading}" as its first sentence`);
    }
  });
  return problems;
}
