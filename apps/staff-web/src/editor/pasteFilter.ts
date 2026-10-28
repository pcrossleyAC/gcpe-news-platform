/**
 * Reduces pasted HTML (from Word, a web page, anywhere) to the same shared allow-list the body
 * editor's own schema enforces and the server sanitiser (apps/nrms/src/text/sanitize.ts) keeps
 * — task-4-brief.md: "Paste is reduced to the same set." Wired as TipTap's
 * `editorProps.transformPastedHTML` (BodyEditor.tsx), so it runs *before* ProseMirror ever
 * parses the clipboard content against the editor's schema.
 *
 * Browser-only (`DOMParser`/`document`) — constraints.md forbids browser code from importing
 * the server's own sanitiser (`sanitize-html` is Node-only), so this is a second, independent
 * implementation of the *same* allow-list, built only from the shared zod-only constants
 * (`BODY_TAGS`/`BODY_ATTRIBUTES`/`BODY_SCHEMES`) so it can never list a tag/attribute/scheme the
 * server doesn't also keep.
 */
import { BODY_ATTRIBUTES, BODY_SCHEMES, BODY_TAGS } from "@gcpe/nrms-contract";

const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = BODY_ATTRIBUTES;
const ALLOWED_SCHEMES = new Set<string>(BODY_SCHEMES);
/** Matches the server sanitiser's `transformTags: { b: "strong" }` (apps/nrms/src/text/sanitize.ts); `i` becomes `em`, kept only where `em` is allowed. */
const TAG_ALIASES: Record<string, string> = { b: "strong", i: "em" };
/** Dropped along with their entire contents — never just unwrapped. */
const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "textarea", "option", "svg", "iframe"]);

function isAllowedHref(href: string | null): boolean {
  if (!href) return false;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  return !!match && ALLOWED_SCHEMES.has(match[1]!.toLowerCase());
}

function appendChildren(source: Node, target: Node, allowed: ReadonlySet<string>): void {
  for (const child of Array.from(source.childNodes)) appendFiltered(child, target, allowed);
}

function appendFiltered(node: Node, target: Node, allowed: ReadonlySet<string>): void {
  if (node.nodeType === Node.TEXT_NODE) {
    target.appendChild(node.cloneNode(true));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = TAG_ALIASES[el.tagName.toLowerCase()] ?? el.tagName.toLowerCase();

  if (SKIP_CONTENT_TAGS.has(tag)) return;

  if (!allowed.has(tag)) {
    // Not in the allow-list: drop the wrapper, keep its children (same as the server's
    // sanitiser — "drops disallowed tags but keeps their text").
    appendChildren(el, target, allowed);
    return;
  }

  const copy = target.ownerDocument!.createElement(tag);
  for (const attrName of ALLOWED_ATTRIBUTES[tag] ?? []) {
    const value = el.getAttribute(attrName);
    if (value === null) continue;
    if (tag === "a" && attrName === "href" && !isAllowedHref(value)) continue;
    copy.setAttribute(attrName, value);
  }
  appendChildren(el, copy, allowed);
  target.appendChild(copy);
}

/** Runs `html` through the allow-list and returns the cleaned markup. `tags` narrows the tag list
 * (the minister biography passes BIO_TAGS, which has no `asset`); attributes and schemes stay the
 * shared body ones. */
export function reduceToAllowedHtml(html: string, tags: readonly string[] = BODY_TAGS): string {
  const allowed = new Set<string>(tags);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const container = document.createElement("div");
  appendChildren(parsed.body, container, allowed);
  return container.innerHTML;
}
