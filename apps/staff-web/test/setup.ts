// Loaded for every apps/staff-web test (vitest.config.ts's jsdom project) — jest-dom's
// matchers (toBeInTheDocument, toHaveTextContent, etc.), registered once here so individual
// test files don't each need their own import.
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// A pending Button that has focus announces its new accessible name through a module-level
// live-announcer: a node appended straight to document.body (outside any React tree, so
// testing-library's cleanup() never touches it), referencing the button's id, and removed only
// after a real 7s timeout. A test file runs many tests well inside that window, so a later
// test's axe scan can still find that transient node — now pointing at an id whose button the
// previous test already unmounted. Clearing the announcer's own log elements after every test
// keeps that one test's pending-button announcement from being examined by the next.
afterEach(() => {
  document.querySelectorAll('[data-live-announcer] [role="log"]').forEach((log) => {
    log.replaceChildren();
  });
});

// Task 4: jsdom has no layout engine, so it doesn't implement `document.elementFromPoint` —
// ProseMirror's view (the body editor, editor/BodyEditor.tsx) calls it on every mousedown to
// resolve a document position from pixel coordinates. Without this, clicking inside the editor
// in a test throws (uncaught, outside the test's own try/catch) instead of just no-op'ing the
// coordinate lookup jsdom can never answer.
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}
