import { useEffect } from "react";

/**
 * Sets `document.title` to `"<text> — GCPE News Staff"` for as long as the calling screen is
 * mounted (I5, WCAG 2.4.2: every screen needs a distinct title). Call with the exact same text
 * as the screen's own `h1` — the two should always agree. `null`/`undefined` (e.g. a page still
 * loading, before it has an `h1` to match) leaves the title untouched rather than clobbering
 * whatever's there — useful when a parent needs to call this unconditionally (every render,
 * same as any other hook) but only sometimes actually owns the title, deferring to a child
 * section's own call the rest of the time (ReleaseEditorPage/HeaderSection).
 */
export function useDocumentTitle(text: string | null | undefined): void {
  useEffect(() => {
    if (text) document.title = `${text} — GCPE News Staff`;
  }, [text]);
}
