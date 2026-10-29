/** Dispatched (not bubbling) on the target of {@link scrollToAndFocus} just before it's focused,
 * so a closed {@link SectionDisclosure} in that section opens itself first. */
export const REVEAL_EVENT = "gcpe:reveal";

/**
 * Scrolls the element with this id into view and moves focus to it. Used by "why is this
 * disabled" reason lists (ActionsSection's Approve/Publish blockers) to take the user straight
 * to the section a problem is about, instead of leaving them to scroll and hunt by hand. The
 * target needs `tabIndex={-1}` (a plain heading/section isn't focusable on its own) — every
 * section id this is ever pointed at sets that.
 */
export function scrollToAndFocus(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.dispatchEvent(new CustomEvent(REVEAL_EVENT));
  // jsdom (vitest) has no scrollIntoView implementation at all — optional, same as a real
  // browser lacking smooth-scroll support: focus is the part that actually matters.
  el.scrollIntoView?.({ block: "center" });
  el.focus();
}
