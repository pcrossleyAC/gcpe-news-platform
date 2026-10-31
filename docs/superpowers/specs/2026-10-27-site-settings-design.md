# Site settings: banner, footer, social links, theme, history

Port of the news.gov.bc.ca "site settings admin" (`News-Hub/gcpe-news-webapp`, branch
`admin-screens`, diff `dd5fd28..admin-screens`) to this platform. The .NET work moved the site
banner, footer links, Connect-page social accounts and theme colours out of code into one
published settings document that non-developers edit, with per-editor drafts, a conflict check
when two people publish, and a history every revision can be restored from. The behavioural
reference is that diff; this document records what carries over, what changes because this
platform is different, and the calls made without the user (marked **[call]**).

The user asked to skip the questions and start, so every **[call]** below is the builder's,
open to the user's review.

## Why

Staff (not developers) must be able to put up a banner (a post-election notice, a wildfire
emergency), fix a footer link, keep the social accounts current and adjust colours, and undo a
mistake, without a deploy. Success: a SiteEditor does each of those in the Hub and the public
site shows it, and any earlier published state can be brought back.

## Goals

- One settings document with five sections: **banner**, **theme**, **footer**, **connect**,
  **ministryPages** (the section headings of the ministry pages' side column, shared by every
  ministry).
- Each ministry's own side-column links (Featured Topics, Featured Services, ministry website,
  photos, videos) editable in the Hub's Organizations edit form, and shown in a new side column
  on the public ministry pages, as on news.gov.bc.ca. (User, 2026-10-27: "each ministry has
  their own links but section names are the same for all ministries".)
- Hub screens under **Website**: Banner, Footer, Social links, Theme, Settings history.
- Each editor has one draft of the whole document; Save draft, Publish (with an optional note),
  Discard draft; a publish that would overwrite someone else's newer publish is refused and the
  editor chooses "keep mine on top of theirs" or "discard mine".
- Every publish is kept; restoring an old revision publishes it again as a new revision.
- The public site shows the published settings: banner (scheduled, optionally dismissible),
  footer, a new Connect page, theme colours.

## Non-goals

- Font, logo and the Blue Bridge banner stay as they are (tenant config / existing switch).
- RSS feeds on the Connect page: not part of this work.
- A separate admin app or separate sign-in (the .NET version needed one; here the Hub is it).

## Anti-goals

- A banner or footer change must not leave pages showing different footers for long, nor
  take the site down while ~35,000 pages rebuild.
- Nothing typed by an editor may become markup on the public site (plain text, safe URLs only).
- A failed or conflicting publish must never lose the editor's work.

## Data model — `@gcpe/site-settings` (new package, browser-safe: zod only)

`SiteSettings` (JSON, camelCase), `schemaVersion: 1` **[call: this platform starts at 1; the
.NET v1→v2 upgrade does not apply]**:

- `banner`: `enabled` (bool), `style` (`"info" | "emergency"`), `message` (plain text),
  `links` (`{text, url}[]`), `dismissible` (bool), `startsAt`, `endsAt` (ISO 8601 instants or
  null).
- `theme.colors` **[call: this site's own colour tokens, not news.gov's]**: `primary`,
  `primaryText`, `accent`, `text`, `mutedText`, `surface`, `background`, `border` (the existing
  `colorsSchema` in `packages/config/src/theme.ts`) plus `bannerInfo`, `bannerEmergency`.
  Font, logo and footerLinks are not in the document.
- `footer`: `helpText`, `helpLinks`, `connectLinks`, `moreInfoLinks` (`LinkSetting[]`),
  `copyrightHolder`.
- `connect`: for each network in this order — `facebook` Facebook, `x` X, `instagram`
  Instagram, `threads` Threads, `bluesky` Bluesky, `flickr` Flickr, `youtube` YouTube, `blogs`
  Blogs — `{ featured: LinkSetting[], accounts: LinkSetting[] }`. Display order: featured as
  stored, then accounts sorted by `text` (locale compare, case-insensitive).
- `ministryPages` (labels, plain text, 1–60 chars each; defaults are news.gov.bc.ca's):
  `moreFromMinistry` "More from this Ministry", `ministryWebsite` "Ministry Website",
  `ministryPhotos` "Ministry Photos", `ministryVideos` "Ministry Videos", `featuredTopics`
  "Featured Topics", `featuredServices` "Featured Services", `mediaContacts` "Media Contacts".
  Validation (field `ministryPages.<label>`): blank ⇒ "Enter a heading."; over 60 chars or `<`
  `>` ⇒ "Use plain text, 60 characters or fewer." Section label "Ministry pages".
- `LinkSetting`: `text`, `url`, optional `id` (kept for analytics, not editable), optional
  `summary`.

Published metadata lives beside the document, not in it: `revision`, `publishedAt`,
`publishedBy`, `note`.

### Validation (exact messages; field paths as shown)

| Field | Rule | Message |
|---|---|---|
| `banner.style` | info or emergency | Choose Information or Emergency. |
| `banner.message` | enabled ⇒ not blank | Enter a message, or turn the banner off. |
| `banner.message` | ≤ 300 chars | Keep the message to 300 characters or fewer. |
| `banner.message` | no `<` or `>` | Use plain text. Add links below instead of HTML. |
| `banner.endsAt` | both set ⇒ end > start | The end time must be after the start time. |
| `theme.colors.<c>` | `^#[0-9A-Fa-f]{6}$` | Use a colour like #013366. |
| contrast (only when all colours valid) | ≥ 4.5:1 | Too faint to read {where} ({ratio, one decimal}:1, needs 4.5:1). Pick a darker shade. |
| `footer.helpText` | ≤ 200 chars | Keep the help text to 200 characters or fewer. |
| `footer.helpText` | no `<` `>` | Use plain text. |
| `footer.copyrightHolder` | not blank | Enter who holds the copyright. |
| `<list>[i].text` | not blank | Enter the link text. |
| `<list>[i].url` | safe URL | Must start with https:// or / (a page on this site). |
| `<list>[i].summary` | ≤ 200, no `<` `>` | Use plain text, 200 characters or fewer. |
| `<list>[i].id` | `^[A-Za-z][A-Za-z0-9_-]{0,63}$` | Link id must start with a letter and use only letters, digits, - or _. |

Contrast pairs and their `{where}` / field: `text` on `background` ("on the page background",
`theme.colors.text`); `text` on `surface` ("on panels", `theme.colors.surface`); `primaryText`
on `primary` ("on the header", `theme.colors.primaryText`); white on `bannerInfo` and on
`bannerEmergency` ("behind white text"). Luminance/ratio maths as `contrastRatio` in
`packages/config/src/theme.ts`. Safe URL: no surrounding whitespace, and either starts with `/`
but not `//` or `/\`, or parses as an absolute `https:` URL with a host.

Banner visibility at instant `now`: `enabled && (startsAt null || now >= startsAt) && (endsAt
null || now < endsAt)`.

### Defaults

What the site shows before anything is published: `config/tenants/<tenant>.site-settings.json`
when it exists, else defaults derived from the tenant's `site.theme` (its colours; banner
colours `#013366` / `#D8292F`; footer `moreInfoLinks` = its `footerLinks`; empty help and
connect lists; banner off). `bc.site-settings.json` carries the news.gov.bc.ca defaults
(`Gov.News.Settings/defaults.json`: the footer lists with their ids, the 83 social links,
"Government of British Columbia") **with the banner off [call: news.gov's default banner is
the post-election notice; this site must not start showing it]**. Defaults must validate.

## Storage and publishing — NRMS

NRMS owns website settings already (SiteEditor role, outbox to the News API).

- `site_settings_revisions`: `revision` (PK, 1, 2, …), `document` jsonb, `published_at`,
  `published_by_id`, `published_by_name`, `note`. The newest row is live. Never pruned.
- `site_settings_drafts`: `editor_id` (PK, the Core user id), `document`, `base_revision`
  (int, null = nothing was live), `updated_at`.
- **Concurrency token = base revision [call: replaces the blob ETag]**. Publish, in one
  transaction under a lock: validate (invalid ⇒ nothing written); if the live revision ≠ the
  base revision ⇒ conflict, nothing written; else insert revision live+1, delete the
  publisher's draft (others keep theirs), write `site_log` area `settings`, enqueue the event.
- Building a document for Save draft / Publish: start from the editor's draft, else live, else
  defaults; replace this screen's section; save as the draft (with the base revision the
  screen loaded). Save draft always saves, then reports validation problems.
- Rebase ("keep mine on top of theirs"): live (or defaults) + this screen's section, base =
  live revision; reports which other sections of the old draft were set aside.
- Restore N: publish revision N's document with note `Restored revision N`, guarded by the
  base revision the history screen showed; it also deletes the restorer's draft.
- `differingSections(a, b)`: those of Banner, Theme, Footer, Social links whose JSON differs.
- Banner times: the Hub sends BC wall-clock (`startsAtLocal`, `endsAtLocal`, no offset); NRMS
  converts with the tenant time zone, as carousels do (`goLiveAtLocal`).

Roles: read = `canManageWebsite` (NRMS.SiteEditor or Core.Admin); write = NRMS.SiteEditor,
as every other Website write.

## Delivery — NRMS → News API → public site

- Event `site.settings.published` (`source: nrms`): `{ revision, publishedAt, document }`.
- News API stores the newest revision (`site_settings`, one row, older revisions ignored),
  records change kind `site_settings`, serves `GET /api/v2/site-settings` →
  `{ revision, publishedAt, document }`, or 404 when nothing is published.
- Public site: each sync turn fetches the settings (404 ⇒ tenant defaults; fetch failure ⇒
  keep the last applied, as the .NET reader does) and passes them to every render.
  **[call]** per section, cheapest correct effect:
  - **theme**: regenerate `assets/theme.css` (page `static`) — no page rebuild.
  - **banner**: written to `assets/site-banner.json`; every page carries an empty placeholder
    and a small inline script that fetches it (no-cache), shows it if visible *now* (so the
    schedule works with no rebuild), with role="alert" for emergency, and a close button when
    dismissible (dismissal not remembered, as on news.gov). Hidden while the Blue Bridge
    banner shows. No banner without JavaScript **[call]**.
  - **footer**: rendered into every page ⇒ a footer change rebuilds every page (like Blue
    Bridge, via the site-state marker: add a hash of the footer and the copyright year, so
    the year also rolls over each January).
  - **connect**: a new public page `/connect/` (page id `connect`) ⇒ only it is rebuilt.
  - **ministryPages**: the headings are baked into ministry pages ⇒ a change rebuilds every
    ministry page (and nothing else).
- Links starting with `/` are relative to the public site's base path (`/site`) **[call]**.

## Ministry page side column

- Per-ministry data already exists in Core's organization record and already reaches the
  public site through `org.upserted` → News API ministry DTO: `url` (ministry website),
  `topicLinks`, `serviceLinks` (`{text, url}[]`, ordered), `social.flickrUrl`,
  `social.youtubeUrl`. Media contacts are already shown.
- Core's staff profile PATCH (`orgProfilePatchSchema`) gains `url`, `topicLinks`,
  `serviceLinks`, `social.flickrUrl`, `social.youtubeUrl`, editable by NRMS.SiteEditor and
  Core.Admin like the minister fields (and, like them, stamping `staffEditedAt` so the
  importer won't overwrite them). URLs must be https (topic/service links: the safe-URL rule;
  ≤ 20 links per list **[call]**).
- Organizations edit form gains **Ministry page links**: Ministry website, Photos (Flickr)
  address, Videos (YouTube) address, Featured Topics and Featured Services lists (add,
  remove, reorder; text + web address).
- Public ministry page: a side column (`<aside>`, after `<main>`'s heading on narrow screens,
  left column on wide ones) with, in order: Media Contacts (moved from the body), More from
  this Ministry (Ministry Website, Ministry Photos, Ministry Videos — each only when its
  address is set), Featured Topics, Featured Services; headings and the three link labels
  from `ministryPages`; empty groups omitted. "Factsheets" and "Read Bio" are not carried
  over: this site has no per-ministry factsheet or biography page **[call]**.

## Ministry abbreviation (added by the user, 2026-10-27)

NRMS numbers releases from the lead ministry's abbreviation and refuses approval without one,
but no Hub form sets it (Add ministry stores none). The Add ministry and edit forms gain an
**Abbreviation** field, Core.Admin only: 2–10 capital letters or digits (stored upper-case),
unique across organizations; changing it affects only releases approved afterwards.

## Not-public hint on Organizations (added by the user, 2026-10-27, QA feedback)

Deactivate and Reactivate never change an organization's Public flag, so a ministry that was
made non-public stays hidden after reactivation. The Organizations screen says so: after a
reactivation of a non-public ministry the status adds "It isn't public: tick Public to list it
on the public site.", and every non-public row shows "Not public" beside its name.

## Hub screens (Website section, manage roles)

Tabs added after the existing ones: **Banner**, **Footer**, **Social links**, **Theme**,
**Ministry pages** (the seven headings, one text field each, with a "Reset to defaults"
that fills the form only), **Settings history**. Strings follow news.gov where it makes sense:

- Publish bar on every editor: "Draft saved · not yet live" / "No unpublished changes"; "Live:
  revision {n}, published by {who} on {date}" / "Nothing published yet; the site uses its
  built-in defaults."; "Note for the history log (optional)"; Discard draft (only with a
  draft), Save draft, Publish.
- Statuses: "Draft saved. It isn't live until you publish." · "Draft saved, but it has
  problems to fix before it can be published." · "Published revision {n}. Visitors see it
  within a few minutes." **[call: static site, so not "two minutes"]** · "Draft discarded.
  Showing what is live."
- Conflict: "Someone published while you were editing" / "Revision {n} was published by {who}
  on {date}. Nothing of yours was published, and your draft is saved." / "Your draft differs
  from it in: {sections}." / buttons "Keep my {section}, on top of their version" and "Discard
  mine, use theirs"; after rebase "Your {section} changes now build on revision {n}. Check
  them, then publish." (+ " Unpublished changes to {list} were set aside.").
- Errors in other sections: "Other parts of the draft have problems that block publishing:".
- **Banner**: type Off / Information / Emergency (Off keeps the previous style); Message
  (counter "{n} / 300"); links (not reorderable); Show from / Hide after (BC time, blank =
  immediately / until turned off); "Visitors can close the banner"; live preview.
- **Footer**: Help text + help links; Connect with Us links; More Info links; Copyright holder
  ("Shows as “© {year} {holder}”"). Footer lists reorderable; ids kept and moved with links.
- **Social links**: one tab per network with counts; featured (reorderable, with
  description) and other accounts (sorted by name); only the open network changes.
- **Theme**: a colour input per colour with its hex and a live "Readable r:1" / "Too faint
  r:1" badge; "Reset to defaults" puts the defaults in the form only; live preview.
- **Settings history**: Revision, When (BC time), Who, Note; Live badge; Restore… → "Restore
  revision {n}?", what it changes, then restore or cancel; statuses as news.gov ("Revision {n}
  is live again, as revision {m}.", "Nothing was restored: revision {live} was published while
  you were looking. Check it and try again.").
- Times shown in the tenant time zone (America/Vancouver).

## Left to the builder

Component structure, the exact preview styling, how the hook shares draft/publish/conflict
state between screens, the inline banner script's markup, and test layout — following the
existing Website screens (`useVersionedSave`, `InlineAlert`, `BusyButton`, `useAnnouncer`,
focus rules, axe sweep).

## Amendment 2026-10-31: Publish asks first, and can publish only this screen (W4)

Owner approved 2026-10-31 (suite review W4). This changes "Storage and publishing — NRMS" and
the publish bar in "Hub screens":

- **Publish** opens a confirmation, "Publish your changes?", worded as Restore's: "Compared with
  what is live now, this publishes changes on: {screens}." (the draft's `draftSections`, plus
  this screen when it has unsaved typing), then "Visitors see it within a few minutes." With
  nothing different: "Your draft is the same as what is live now. Publishing it makes a new
  revision with the same settings."
- When the changes cover other screens as well as this one, the confirmation offers **Publish
  only {screen}** beside **Publish all changes** (else just **Publish**). It names other screens
  with problems: "{screens} has problems that block publishing all changes. Publish only {screen}
  still works."
- `POST /site/settings/publish` takes `onlySection: true`. NRMS saves the draft as before, then,
  under the same lock and the same base-revision check, publishes live (or the defaults) with
  only this section replaced, so another section's stale or invalid draft neither goes live nor
  blocks it. The publisher's draft is kept for its other sections, re-based on the new revision;
  with nothing else left it is deleted, as Publish does. Log: "Published revision {n}, {Section}
  only[: note]".
- Status after it: "Published revision {n}, with only your {screen} changes. Visitors see it
  within a few minutes." plus " Your draft still has changes on {screens}." when some remain.
- The hint above the buttons: "Publish and Discard draft apply to your whole draft, on every
  settings screen. Publish lets you publish only this screen instead."

### Fix round 1 (owner approved 2026-10-31)

- `onlySection` doesn't need the draft's base to be the live revision. It conflicts only when
  someone else changed this same section since the draft's base (base document vs live, filled
  from the defaults). Otherwise it publishes live with this section replaced, so other sections
  they published stay. A draft based on an older revision is left exactly as it was (its base
  unchanged), so a later full Publish still meets the conflict check; a draft based on live is
  re-based as before.
- The revision's note records the partial publish, as Restore does: "{Section} only" or
  "{Section} only: {note}" (Settings history shows it; the log reads "Published revision {n}:
  {that note}").
- Rebase ("Keep mine on top of theirs") throws nothing of the editor's away. It is live plus this
  section plus every other section the editor changed against their draft's base. It returns
  `alsoChangedByThem` (the kept sections the other editor changed too) instead of `setAside`;
  status suffix: " Your draft still has your changes on {list}, which they changed too: check
  them before you publish them." This replaces the "set aside" wording in "Storage and
  publishing — NRMS" and "Hub screens".

### Fix round 2 (owner approved 2026-10-31)

- "Someone else changed this section" is judged revision by revision after the draft's base,
  leaving out the publisher's own revisions, so a second Publish only on the same screen isn't a
  conflict with the editor's own first one. Rebase's `alsoChangedByThem` uses the same rule.
- After a stale Publish only, the draft is re-based on the new revision (new revision plus the
  editor's other changed sections) unless one of those sections overlaps what someone else
  changed since the base; then it is left as it was.
- Publish, Save draft and Rebase read the editor's draft row FOR UPDATE, so a save from another
  tab is never silently overwritten.
- For one release, `POST /site/settings/rebase` also returns `setAside: []` for Hub tabs opened
  before this change.

