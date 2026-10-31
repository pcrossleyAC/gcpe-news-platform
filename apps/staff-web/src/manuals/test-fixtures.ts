import type { HubManualPage, HubManualsData } from "../../../../scripts/manuals-lib.mjs";

/** A page for tests, as the Hub ships it; the html is what the compiler would make. */
export function fixturePage(over: Partial<HubManualPage> & Pick<HubManualPage, "id" | "manual">): HubManualPage {
  return {
    title: over.id,
    order: 1,
    routes: [],
    screens: [],
    topics: [],
    html: `<p>Body of ${over.id}.</p>`,
    hash: "0".repeat(64),
    changed: "2026-10-30",
    ...over,
  };
}

/** Pages for the visibility and context-Help tests: a stub per kind, plus a second topic. */
export const FIXTURE: HubManualsData = {
  pages: [
    fixturePage({ id: "core-admin-overview", manual: "core-admin", title: "Core administrator manual", html: "<p><strong>Who this is for:</strong> Core administrators (Core.Admin).</p>" }),
    fixturePage({ id: "government-terms", manual: "core-admin", title: "Government terms", order: 20, routes: ["/government-terms"], changed: "2026-10-05" }),
    fixturePage({ id: "site-editor-releases", manual: "nrms-site-editor", title: "Releases for site editors", routes: ["/releases"] }),
    fixturePage({
      id: "editor-releases",
      manual: "nrms-editor",
      title: "Writing a release",
      routes: ["/releases"],
      topics: ["signing-in"],
      html: '<p>Start in Releases. See <a href="/hub/help/manuals/topic/signing-in">Signing in</a> and <a href="/hub/help/manuals/nrms-editor/editor-publishing">publishing</a>.</p>',
    }),
    fixturePage({ id: "editor-publishing", manual: "nrms-editor", title: "Publishing", order: 2, routes: ["/releases/scheduled"] }),
    fixturePage({ id: "viewer-overview", manual: "nrms-viewer", title: "Reading releases", routes: ["/releases"] }),
    fixturePage({ id: "calendar-readonly-overview", manual: "calendar-readonly", title: "Using the calendar", routes: ["/calendar"] }),
    fixturePage({ id: "signing-in", manual: "topic", title: "Signing in", html: "<p>Use your IDIR.</p>" }),
    fixturePage({ id: "site-editor-only-topic", manual: "topic", title: "Hidden topic", html: "<p>Secret.</p>" }),
    fixturePage({ id: "site-editor-releases-2", manual: "nrms-site-editor", title: "More for site editors", order: 2, topics: ["site-editor-only-topic"] }),
  ],
};
