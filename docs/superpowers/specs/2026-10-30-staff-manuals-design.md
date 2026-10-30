# Staff manuals in the Hub — Design

Date: 2026-10-30. Owner conversation: 2026-10-30 (Hub chat).

## 1. Why

The old news platform had almost no admin screens: changes were SQL, code edits and tickets. The
new platform hands most of that to people in the Hub (Organizations, government terms, site
settings, users and roles, and so on). That is a large change in who does what, and nobody yet
has a written account of it.

Since 2026-10-05, notes for the manuals have been collected in `docs/manuals/running-notes.md`
(287 tagged notes, last added around 2026-10-12), with the manuals themselves deferred until the
screens settled. Since then the screens have changed a lot (parity work, Hub reworks, files,
Find a release) without notes. The screens are now settled enough to write the manuals.

## 2. Who reads them, in order

1. **Core admin** (`Core.Admin`) — first. Their question: *where can I administer things, and what
   can I administer?* Their manual opens with a map of every admin screen: what it controls, who
   else it affects, and where in the Hub it is.
2. **The top role in each app**:
   - releases and the website: `NRMS.SiteEditor`;
   - subscribers: `NoD.Admin`;
   - Calendar: `Calendar.SysAdmin` and `Calendar.Administrator`.
3. **Everyone below them, down the hierarchy**:
   - releases and the website: `NRMS.Editor`, then `NRMS.Viewer`;
   - subscribers: `NoD.Editor`, then `NoD.Viewer`;
   - Calendar: `Calendar.Advanced`, then `Calendar.Editor`, then `Calendar.ReadOnly`.

   The running notes' audience tags (Administrator, Site editor, Editor, Viewer, the Calendar
   audiences) map onto these roles.

Operations and developer material (deploys, servers, cutover) is **not** part of this series. It
stays in `docs/deploy/` and is outside this design. *(My call — the owner didn't object when it
was raised.)*

## 3. Goals

- Each reader finds, in the Hub, the manual for the work their role allows, without reading other roles' material.
- The Core admin manual answers "what can I administer, and where" on its first page.
- The manuals stay true as the software changes, and updates go live with the code.
- The same content can be sent as a Word document.
- The owner can review changes later, at their own pace.

## 4. Anti-goals (owner's words: "too technical or word-salad like")

- No technical language: no API paths, role ids in running text, database terms, or how things work inside. Role ids may appear once, in a "who this is for" line, next to the role's plain name.
- No word salad: no sentences that stack qualifiers without saying anything, no filler intros, no restating the heading.
- No describing things the reader can't see or do.

## 5. What gets built

### 5.1 Manual sources
- One plain-text (Markdown) file per manual page, kept in the repo under `docs/manuals/`, organised by app and topic.
- Each page carries a small header naming:
  - its manual (which role or roles it is for);
  - its app or topic;
  - the Hub screens it describes (their routes), used by the up-to-date check and by the Help buttons;
  - a last-changed date.
- A task that crosses apps gets **one topic page**, which each role's manual links to instead of repeating. Examples: a new government; publishing a release that emails subscribers.
- `docs/manuals/new-government.md` already exists and becomes the first topic page.

### 5.2 In the Hub
- Help becomes the home of the manuals. A reader sees only the manuals and pages for roles they hold, using the same role rules the side menu already uses. A Core admin sees the admin map first.
- Help opens at the right page from any screen, extending the existing area-aware Help button.
- The existing Help content stays:
  - the keyboard shortcuts table;
  - the glossary;
  - the "How do I…" pointers, which become the short entry points into the manuals.
- Pages are rendered from the sources at build time. No editing of manuals in the Hub.

### 5.3 Word export
- "Download as Word" on each manual produces one .docx built from the same sources. The cover carries the manual's name, its roles and the date of the software version.
- Only the manuals the reader can see are downloadable.

### 5.4 Keeping them current
- **Rule:** a change that alters what a screen shows or does updates that screen's manual page in the same change.
- **Check:** an automated test fails the build when a source file behind a screen named in a manual page changes but the page doesn't. The page header lists the screens. A deliberate "no manual change needed" note in the change can satisfy the check. The test works the same way as the existing guard tests (for example, the one that keeps every table wrapped).
- **Writing check:** the independent reviewer that already reviews each change also reads changed manual pages against the anti-goals in §4.
- The running notes are retired as each note is folded into its manual. The file is deleted once it is empty, and a test stops new notes being added after that.

### 5.5 Owner review later
- A **"Changed since your last review"** list in Help, visible to Core admins. Each entry shows a manual page that changed, the date, and the before and after text. The owner marks entries reviewed. Corrections go out with the next change.

## 6. First delivery (order)

1. The plumbing:
   - page format;
   - Hub rendering by role;
   - Word export;
   - the up-to-date check;
   - the review list.
2. **Core admin manual**: the admin map, plus a page per admin screen.
3. **Top-role manuals** for each app.
4. **Lower-role manuals**, down the hierarchy.

Each manual ships when written. Content is written by reading the screens as built and using them on a local review Hub, not only from the notes, because the notes stop at 2026-10-12.

## 7. Left to the builder

- The Markdown header format.
- How pages render in the Hub. The rendering must match existing Hub styles and stay accessible: no axe violations, and no sideways scrolling at 390 px.
- How the .docx is generated.
- Whether screenshots appear. If they do, they must be regenerated automatically, or the pages must work without them.
- The exact page list inside each manual.

## 8. Calls made after the builder check (mine, not the owner's)

- **Review list storage (§5.5):** one shared list stored on the server: a small table plus a
  Core.Admin-only API. Any Core admin can mark an entry reviewed, and the entry records who did
  it and when. The before and after text comes from git: the build stores each page's previous
  published text next to the current one, so the app keeps no editing history of its own. If
  this adds a migration, it goes into the OpenShift image and manifests and the Windows docs in
  the same change.
- **Writing check (§5.4):** two parts.
  1. An automated plain-language test over `docs/manuals/` that fails on banned patterns:
     API paths, role ids outside the "who this is for" line, database words, and an internal
     jargon list.
  2. The independent review pass the controller already runs on every change before shipping,
     which now also reads changed manual pages against §4.
- **Up-to-date check scope (§5.4):** a CI step, not a unit test. It diffs the change against
  `main`, so CI fetches enough history to do that. It covers only the screen's own folder under
  `apps/staff-web/src/screens/`, not shared components. A `Manual: no change` line in a commit
  message satisfies it.
- **Help button (§5.2):** each page header lists routes. When several pages share a route,
  Help opens the first listed. Routes with no page fall back to the area's manual contents page.
- **Word export (§5.3):** built at build time, so no new runtime dependency is needed in the
  image. Cross-app topic pages are inlined into each manual's Word file, because links don't
  work on paper. The cover is plain, with the BC logo (already approved for the repo).
- **Dates (§5.1, §5.3):** taken from git at build time. Builds need full history, and CI
  checkout uses `fetch-depth: 0` where manuals build.
- **new-government.md:** split by role into the Core admin manual and the site-editor manual.
  Its operator-only section moves to `docs/deploy/`. URLs a reader never types are removed.
- **Running notes:** folded in as each manual is written; this is part of the first delivery.
  Operations and Developer notes move into `docs/deploy/` or developer docs. The "no new notes"
  test turns on once the file is deleted.

## 9. Owner decisions (2026-10-30)

- **A Core admin sees every manual**, for every app and role, because they assign roles and
  need to know what each role sees and does. Their own admin manual comes first.
- **A higher role also sees the manuals of the roles below it in the same app.** For example,
  a Site editor also sees the Editor and Viewer manuals. Each reader's own manual is listed
  first, then the lower ones. This refines §3's "without reading other roles' material":
  readers don't see manuals for apps or roles above theirs.
