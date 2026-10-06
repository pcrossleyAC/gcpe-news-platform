# Legacy NoD email sample — As-It-Happens to a media distribution list member (2026-09-21)

Source: a production As-It-Happens email received by a media-list member 2026-09-21 07:15, forwarded by Carolynn Hunter on 2026-10-05 (Q24). Her note: "For anyone subscribed to the media distribution lists, there is no banner on the As it Happens emails." The PDF isn't committed (staff addresses in headers). Layout only. Applies to 4c (spec §5.4).

- **From:** `noreply.newsondemand@gov.bc.ca`. **Subject:** `BC Gov News - <title>` (same as a subscriber's As-It-Happens).
- **No banner, no footer.** A plain page in BC Sans / Noto Sans / Calibri / Arial at 18px (legacy's inline media template, `NodTask.cs:359-388`).
- **Body: the full release as text** (legacy `TextContent`, built by `Release.FromEntity(post).ToTextDocumentAsString()`, `ReleasePublisher.cs:48-49`, paragraphs split on blank lines), in this order:
  - "For Immediate Release"
  - the release key (e.g. `2026TT0099-001095`)
  - the date ("Sept. 21, 2026")
  - the ministry name
  - the release type in capitals ("TRAFFIC ADVISORY") and, on the next line, the headline
  - the body paragraphs, with the location lead-in ("PORT ALBERNI - ...")
  - "Contact:" and the contact block lines
- Then "▶ READ MORE" (bold blue link to the release) and the grey topic line ("Economy, Transportation and Transit"). The item template's separate title link is removed for media sends (`NodTask.cs:237-239`); advisories also lose the READ MORE link (`NodTask.cs:240-243`).
- Media-distribution-list names don't appear in the topic line (`NodTask.cs:273`).
- One email per release, never grouped (`NodTask.cs:303`); priority 40.
