/**
 * Fix round 1 (3f Task 4), finding 3: "axe clean" wasn't actually tested for any of this
 * task's new components — same helper/pattern as apps/staff-web/src/a11y.test.tsx, but
 * exercising each component with its more complex states shown (a dialog open, a non-default
 * tab active), not just its default render.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { LANG_EN, LANG_FR } from "@gcpe/nrms-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DocumentsSection } from "./DocumentsSection";
import { DocumentTabs } from "./DocumentTabs";
import { DocumentLanguageForm } from "./DocumentLanguageForm";
import { FilesSection } from "./FilesSection";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/**
 * Same as {@link seriousViolations}, but for a render with an open React Aria `Modal`:
 * verified directly (`'inert' in window.HTMLElement.prototype` is `false` on jsdom 30.1.2) that
 * jsdom has no `inert` support, so react-aria's background-hiding (`ariaHideOutside`) falls
 * back to plain `aria-hidden="true"` with no actual focus removal — in a real browser the same
 * code path sets `element.inert = true`, which *does* remove focusability, so this exact
 * "hidden content is still focusable" shape never occurs outside a jsdom test. Filtering only
 * `aria-hidden-focus` here (nothing else) keeps the check honest for every other rule.
 */
async function seriousViolationsWithModalOpen(container: Element) {
  const violations = await seriousViolations(container);
  return violations.filter((v) => v.id !== "aria-hidden-focus");
}

function stubSessionFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "user-a", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
      return jsonResponse(200, {});
    }),
  );
}

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const TWO_DOCS = releaseView({
  documents: [
    { id: "doc-1", sortIndex: 0, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] }] },
    { id: "doc-2", sortIndex: 1, layout: "formal", languages: [{ languageId: LANG_EN, pageTitle: "News Release", headline: "Second", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] }] },
  ],
  files: [{ id: "f1", kind: "translation", label: "fr.pdf", url: "/files/f1", contentType: "application/pdf", size: 100 }],
});

const BOTH_LANGUAGES = releaseView({
  documents: [
    {
      id: "doc-1",
      sortIndex: 0,
      layout: "formal",
      languages: [
        { languageId: LANG_EN, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: [] },
        { languageId: LANG_FR, pageTitle: "Communiqué", headline: "Cliniques ouvertes", subheadline: null, organizations: null, byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: [] },
      ],
    },
  ],
});

describe("accessibility (constraints.md: no serious/critical axe violations) — Task 4 documents components", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("DocumentsSection, with the Add-document form open", async () => {
    stubSessionFetch();
    const { container } = render(withAuth(<DocumentsSection view={TWO_DOCS} setView={() => {}} readOnly={false} />));
    await screen.findAllByLabelText("Headline");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add document" }));
    await screen.findByRole("form", { name: "Add document" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("DocumentTabs, with a non-default (French) tab active", async () => {
    stubSessionFetch();
    const { container } = render(withAuth(<DocumentTabs view={BOTH_LANGUAGES} setView={() => {}} documentId="doc-1" readOnly={false} />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "French" }));
    await screen.findByDisplayValue("Cliniques ouvertes");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("DocumentLanguageForm", async () => {
    stubSessionFetch();
    const { container } = render(withAuth(<DocumentLanguageForm view={TWO_DOCS} setView={() => {}} documentId="doc-1" languageId={LANG_EN} readOnly={false} />));
    await screen.findByLabelText("Headline");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("FilesSection, with the remove-confirmation dialog open", async () => {
    stubSessionFetch();
    const { container } = render(<FilesSection view={TWO_DOCS} setView={() => {}} readOnly={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove fr.pdf" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });
});
