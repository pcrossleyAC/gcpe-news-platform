# Open questions for the business

Things the legacy code can't tell us. Each one has a working assumption so the build isn't blocked; when an answer comes in, record it under **Answer**, update the design if needed, and move the row to "Answered".

Status key: **Open** (no answer yet) · **Answered**.

## Open

| # | Question | Why it matters | Working assumption until answered | Raised |
|---|---|---|---|---|
| Q1 | Where do the live webcast URLs (`liveWebcastFlashMediaManifestUrl`, `liveWebcastM3uPlaylist`) come from today? Legacy's Live Feed screen only has an on/off switch. | The News API's home record carries both URLs, and the public site needs them to show the stream. | Site editors type them into plain fields next to the Live Feed switch. | 2026-10-03 |
| Q2 | What does "Project Blue Bridge" (setting key `granville`) actually do on the public site? Who at IGRS approves turning it on? | Nothing in the legacy code we have reads it, so we can't test it end to end. | Keep the switch and its IGRS warning; pass the value through to the News API unchanged. | 2026-10-03 |
| Q3 | Who edits the home-page **resource links** today, and where? Legacy has the table but no screen. | Decides whether NRMS should own them or whether another tool already does. | NRMS gets a simple editor for them (site editors). | 2026-10-03 |
| Q4 | Are photos on Flickr kept **private until the release goes out** for every release, or only some? | Legacy only makes the photo public if the publisher runs in the exact minute of the publish time; a late run leaves it private. We need to know how strict the embargo is. | Every photo is private until its release publishes; we make it public at publish even if the run is late, then check it really is public. | 2026-10-03 |
| Q5 | Is leaving the Flickr photo **out of media-list emails** deliberate? | Legacy strips it; changing it changes what journalists receive. | Keep it out, as legacy does. | 2026-10-03 |
| Q6 | Is the "Update" release type still used? It can't be created in legacy but old ones exist. | Decides whether to build "create Update" or keep Updates as old data only. | Old Updates import and stay editable; no way to create new ones. | 2026-10-03 |
| Q7 | Should release numbering restart each **calendar year** (legacy: `2026HLTH0012-000345`) or each **government term**? | Legacy uses the calendar year for the numbers but files releases under a government term ("2017-2021"). | Calendar year in BC time, as legacy does; the government term is a separate explicit "current term" setting. | 2026-10-03 |
| Q8 | Is it intended that a sent **Advisory can never be unpublished**? | Legacy offers no way back once sent. | Keep it: no unpublish for Advisories. | 2026-10-03 |
| Q9 | Are asset links to **Facebook** still banned "due to privacy concerns"? | Legacy refuses them outright. | Keep the ban. | 2026-10-03 |
| Q10 | Are non-English/French **translations** still uploaded only as PDF files? | Legacy treats them as attached PDFs, not editable text. | PDF uploads only. | 2026-10-03 |
| Q11 | Which two **page images** are hidden in legacy (two ids hard-coded in `ReleaseImagePicker.ascx.cs`), and should they stay hidden? | We're replacing the hard-coding with an "active" flag and need to set it correctly at import. | Import them as inactive. | 2026-10-03 |
| Q12 | Does the live database have rows in **`NewsReleaseHistory`** (old published copies)? If so, from when? | Current legacy code never writes to it, so any rows came from an older version; decides whether the importer brings them over. | Import them if present, as read-only history. | 2026-10-03 |
| Q13 | In production, are legacy uploads stored in **Azure Blob storage** or on a local disk? Is the **Forecast tab** turned on? | Tells the importer where to fetch files from, and whether Forecast is in active use. | Azure Blob; Forecast in use (built with the Calendar phase). | 2026-10-03 |
| Q14 | The plain-text version of a release has a "Connect with the Province of B.C." footer in one legacy path but not another. Should it have it? | Decides what the text rendition and "email me a copy" contain. | Include the footer. | 2026-10-03 |

## Answered

_None yet._
