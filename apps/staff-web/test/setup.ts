// Loaded for every apps/staff-web test (vitest.config.ts's jsdom project) — jest-dom's
// matchers (toBeInTheDocument, toHaveTextContent, etc.), registered once here so individual
// test files don't each need their own import.
import "@testing-library/jest-dom/vitest";

// Task 4: jsdom has no layout engine, so it doesn't implement `document.elementFromPoint` —
// ProseMirror's view (the body editor, editor/BodyEditor.tsx) calls it on every mousedown to
// resolve a document position from pixel coordinates. Without this, clicking inside the editor
// in a test throws (uncaught, outside the test's own try/catch) instead of just no-op'ing the
// coordinate lookup jsdom can never answer.
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}
