/**
 * The Hub's glossary: what its jargon means, in one place. The inline "?" explanations
 * (shared/HelpToggle.tsx) and the Help page's Glossary (screens/help/HelpScreen.tsx) both read
 * it, so a definition is written once.
 *
 * Each definition comes from what the code and docs say (the staff manuals in docs/manuals/,
 * docs/parity/, the Calendar contract and the legacy names), confirmed by the owner (2026-10-29).
 */
export type GlossaryArea = "Releases" | "Website" | "Subscribers" | "Calendar";

export interface GlossaryEntry {
  /** Anchor on the Help page: `/help#glossary-<id>`. */
  id: string;
  term: string;
  /** Other names it goes by on screen (a column header's short form, a legacy name). */
  alsoShownAs?: string[];
  area: GlossaryArea;
  definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: "reference-and-release-number",
    term: "Reference and release number",
    area: "Releases",
    definition:
      "Approving gives a release its reference number (such as NEWS-00012). Some types (a news release, for one) also get a release number, which is part of the public address. Return to draft gives both up; it gets new ones when it's approved again.",
  },
  {
    id: "planned-publish-date",
    term: "Planned publish date",
    area: "Releases",
    definition:
      "Set in Publish settings, it's only a plan: nothing is published at that time. Schedule, under Actions, commits a time. Schedule starts from the planned date when there is one still ahead.",
  },
  {
    id: "media-distribution-lists",
    term: "Media distribution lists",
    area: "Releases",
    definition: "Lists of media contacts a release is emailed to when it's published, chosen in Publish settings. A release is sent to them only once, the first time it's published.",
  },
  {
    id: "news-on-demand",
    term: "News On Demand",
    alsoShownAs: ["NoD"],
    area: "Subscribers",
    definition:
      "The email subscription service. Subscribers choose the ministries, sectors, themes and tags they follow (or all news) and get releases as they happen or in a digest. A release reaches them only if Send to News On Demand subscribers is ticked in its Publish settings.",
  },
  {
    id: "url-key",
    term: "Key (URL key)",
    area: "Website",
    definition: "The part of a public address that names a release, sector, theme or tag. A category's key never changes once it's added.",
  },
  {
    id: "manifest-url",
    term: "Manifest URL",
    area: "Website",
    definition:
      "Live Feed: the address of the live webcast's media manifest (the older streaming format legacy called the Flash media manifest). It's optional, and the public site doesn't use it.",
  },
  {
    id: "m3u-url",
    term: "M3U URL",
    area: "Website",
    definition:
      "Live Feed: the address of the live webcast's M3U playlist (the stream itself). The public site shows its Live Webcast button on every page while Live Feed is on; open pages pick up the change within a minute.",
  },
  {
    id: "project-blue-bridge",
    term: "Project Blue Bridge",
    area: "Website",
    definition:
      "The demise-of-the-Crown switch. Turned on, the public site changes to its mourning theme with a black banner announcing the King's death. Only a Hub administrator can turn it on, after typing a confirmation phrase and confirming the Intergovernmental Relations Secretariat (IGRS) has approved it; every change is logged and emailed.",
  },
  {
    id: "look-ahead",
    term: "Look Ahead",
    alsoShownAs: ["LA"],
    area: "Calendar",
    definition:
      "HQ's report of upcoming activities, grouped into six sections, made as a PDF from the list's current filter. With no To date it covers 60 days and adds the Long Term Outlook. Each activity is listed under its LA Section.",
  },
  {
    id: "not-for-look-ahead",
    term: "Not for Look Ahead",
    area: "Calendar",
    definition:
      "Marks the activity confidential (the old Calendar's Confidential flag): only its lead and shared ministries, and HQ Advanced users and above, see it in the list, reports, the updates feed and search; it isn't offered on the releases Forecast, and a new activity isn't given a Look Ahead section (one it already has is kept).",
  },
  {
    id: "la-section",
    term: "LA Section",
    area: "Calendar",
    definition:
      "The Look Ahead section an activity is listed under. It's worked out from the activity's category, Issue, whether its date is confirmed and its comm materials; HQ Editors and above can choose another (marked Override).",
  },
  {
    id: "la-status",
    term: "LA Status",
    alsoShownAs: ["LA status"],
    area: "Calendar",
    definition:
      "HQ's New or Changed flag on an activity, shown beside it in HQ's Look Ahead and in the list's Status. HQ Editors and above clear it with Clear LA Status (the list's LA status tool) for activities in the next few days (8 by default), so the next Look Ahead flags only what is new or changed since.",
  },
  {
    id: "comm-materials",
    term: "Comm Materials",
    alsoShownAs: ["Comm. Materials"],
    area: "Calendar",
    definition:
      "Communication materials: the products planned for the activity (a news release, for one), chosen from the Calendar's Comm materials list. Required when the activity has a release; they also help decide its LA Section.",
  },
  {
    id: "comm-contact",
    term: "Comm Contact",
    alsoShownAs: ["Comm. Contact"],
    area: "Calendar",
    definition: "Communications contact: the communications staff member responsible for the activity, chosen from the lead ministry's Calendar users (choose the lead ministry first).",
  },
  {
    id: "government-representative",
    term: "Representative",
    alsoShownAs: ["Govt Rep."],
    area: "Calendar",
    definition: "Government representative: who represents government at the activity, chosen from the Calendar's Government representatives list.",
  },
  {
    id: "lead-organization",
    term: "Lead Organization",
    alsoShownAs: ["Lead Org."],
    area: "Calendar",
    definition: "The organization leading the activity, typed in when it's someone other than the lead ministry (a partner or agency, for one).",
  },
  {
    id: "nr-origin",
    term: "Origin",
    alsoShownAs: ["NR origins"],
    area: "Calendar",
    definition: "News release origin: where the activity's news release comes from, chosen from the Calendar's NR origins list. Required when the activity has a release.",
  },
  {
    id: "corp-cal-manager",
    term: "Corp Cal Manager",
    area: "Calendar",
    definition: "The Corporate Calendar manager at GCPE HQ. During the daily change freeze, when content changes are blocked, they can make urgent updates for you.",
  },
];

export function glossaryEntry(id: string): GlossaryEntry {
  const entry = GLOSSARY.find((e) => e.id === id);
  if (!entry) throw new Error(`No glossary entry "${id}"`);
  return entry;
}
