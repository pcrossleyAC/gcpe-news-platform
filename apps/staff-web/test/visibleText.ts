/** The text a sighted user sees in `el`: its text content without anything visually hidden
 * (`.gcpe-visually-hidden`) or hidden from everyone. jsdom has no layout, so this reads the
 * markup rather than the rendering. */
export function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".gcpe-visually-hidden, [hidden]").forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}
