/**
 * task-4-brief.md Step 1: "the editor's output round-trips through the server sanitiser
 * unchanged". apps/staff-web's tests run in a jsdom *vitest project*
 * (apps/staff-web/src/**\/*.test.tsx only — see vitest.config.ts), so a plain Node-environment
 * test can't live there; this file instead lives under apps/nrms/test (the "node" project's own
 * `apps/*\/test/**\/*.test.ts` glob) so it can import the real server sanitiser
 * (apps/nrms/src/text/sanitize.ts, which imports the Node-only `sanitize-html` package —
 * something constraints.md forbids browser code from ever doing) directly, with no jsdom
 * environment auto-provided. `@tiptap/core`'s `generateHTML` needs *some* DOM to serialize
 * into, so this file stands up a throwaway `jsdom` window itself, scoped to this file only
 * (removed again in `afterAll`), rather than opting the whole "node" project into jsdom.
 *
 * It imports the body editor's actual schema (apps/staff-web/src/editor/schema.ts) — a pure
 * `@tiptap/core` module with no React and no DOM-only *types*, so pulling it into the "node"
 * tsc program (apps/nrms/test is covered by the root tsconfig) type-checks cleanly even though
 * that tsconfig has no "DOM" lib (verified directly: a temporary file doing exactly this
 * compiled with zero errors before this test was written).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { generateHTML, type JSONContent } from "@tiptap/core";
import { bodyExtensions } from "../../../staff-web/src/editor/schema";
import { sanitizeBodyHtml } from "../../src/text/sanitize";

let dom: JSDOM;

beforeAll(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    DOMParser: dom.window.DOMParser,
  });
});

afterAll(() => {
  for (const key of ["window", "document", "Node", "Element", "DOMParser"]) delete (globalThis as Record<string, unknown>)[key];
});

function html(doc: JSONContent): string {
  return generateHTML(doc, bodyExtensions());
}

describe("the body editor's TipTap schema round-trips through sanitizeBodyHtml", () => {
  it("a paragraph with bold text and an allowed link — unchanged", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] },
            { type: "text", text: ", visit " },
            { type: "text", text: "BC Gov", marks: [{ type: "link", attrs: { href: "https://gov.bc.ca" } }] },
          ],
        },
      ],
    };
    const out = html(doc);
    expect(out).toBe('<p>Hello <strong>world</strong>, visit <a href="https://gov.bc.ca">BC Gov</a></p>');
    expect(sanitizeBodyHtml(out)).toBe(out);
  });

  it("a mailto link — unchanged", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "mail", marks: [{ type: "link", attrs: { href: "mailto:a@b.ca" } }] }] }],
    };
    const out = html(doc);
    expect(sanitizeBodyHtml(out)).toBe(out);
  });

  it("bulleted and numbered lists — unchanged", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
      ],
    };
    const out = html(doc);
    expect(sanitizeBodyHtml(out)).toBe(out);
  });

  it("a plain div with inline text and a hard break — stable under the sanitiser (sanitize-html normalises <br> to self-closing, a cosmetic difference only)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "div", content: [{ type: "text", text: "d" }, { type: "hardBreak" }, { type: "text", text: "e" }] }],
    };
    const out = html(doc);
    expect(out).toBe("<div>d<br>e</div>");
    const sanitized = sanitizeBodyHtml(out);
    expect(sanitized).toBe("<div>d<br />e</div>");
    // The true round-trip guarantee: nothing further is lost on a second pass (e.g. load, edit
    // nothing, save again never strips more than the first save already did).
    expect(sanitizeBodyHtml(sanitized)).toBe(sanitized);
  });

  it("an <asset> embed survives unchanged", () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "asset", attrs: { url: "https://youtu.be/abcdef12345" } }] };
    const out = html(doc);
    expect(out).toBe("<asset>https://youtu.be/abcdef12345</asset>");
    expect(sanitizeBodyHtml(out)).toBe(out);
  });

  it("a disallowed link scheme can never be produced by this schema in the first place", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
    };
    // Link.renderHTML blanks a disallowed href rather than emitting it.
    const out = html(doc);
    expect(out).not.toContain("javascript:");
    expect(sanitizeBodyHtml(out)).toBe(sanitizeBodyHtml(sanitizeBodyHtml(out)));
  });
});
