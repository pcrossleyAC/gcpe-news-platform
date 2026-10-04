# Open questions for the business

Things the legacy code can't tell us. Each one has a working assumption so the build isn't blocked; when an answer comes in, record it under **Answer**, update the design if needed, and move the row to "Answered".

Status key: **Open** (no answer yet) · **Answered**.

## Open

| # | Question | Why it matters | Working assumption until answered | Raised |
|---|---|---|---|---|
| Q1 | Where do the live webcast URLs (`liveWebcastFlashMediaManifestUrl`, `liveWebcastM3uPlaylist`) come from today? Legacy's Live Feed screen only has an on/off switch (`live_webcast_enabled`). | The public site (bcgov/gcpe-news-webapp, `Hubs/LiveHub.cs`) checks the home record every 15 s and shows the "Live Webcast" button only when the M3U playlist URL is set **and** answers. Nothing in gcpe-hub-develop or any public bcgov repo sets the URLs, so they're probably filled in by the News API server (not public) when the switch is on. | Site editors type the two URLs next to the Live Feed switch, with defaults from environment settings; the switch on/off controls whether they're sent. | 2026-10-03 |
| Q3 | Who edits the home-page **resource links** today, and where? Legacy has the table but no screen. | Decides whether NRMS should own them or whether another tool already does. | NRMS gets a simple editor for them (site editors). | 2026-10-03 |
| Q4 | Are photos on Flickr kept **private until the release goes out** for every release, or only some? | Legacy only makes the photo public if the publisher runs in the exact minute of the publish time; a late run leaves it private. We need to know how strict the embargo is. | Every photo is private until its release actually goes out; we try to make it public right away and check it really is, even if the run is late. As built: the release waits up to 2 minutes for that to succeed before going out without the photo instead (keeping the link, with an alert, and retrying for 24 hours — see C28). | 2026-10-03 |
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
| Q15 | Who may turn on Project Blue Bridge, and should it need a second person to confirm? | Turning it on by mistake publishes a false announcement of the King's death on BC Gov News. | Only Core.Admin can turn it on, after typing a confirmation phrase; every change is logged and emailed to admins. | 2026-10-03 |
| Q16 | Should the Blue Bridge banner text be editable, or stay fixed in the public site's code as today? | The text names King Charles III and computes his age; it must be right on the day it's used. | Keep it fixed in the public site's code, as legacy does. | 2026-10-03 |
| Q17 | When a release is unpublished or deleted, should its translation PDFs and media files stop being downloadable? | Their links have already gone out in the published release; legacy left uploaded files in place. Matters for legal takedowns. | Keep legacy behaviour: files stay downloadable at their (unguessable) addresses until the release is permanently deleted. | 2026-10-04 |

## Answered

| # | Question | Answer | Source | Answered |
|---|---|---|---|---|
| Q2 | What does "Project Blue Bridge" (setting key `granville`) do on the public site? | When the value is non-empty, the public site switches to a mourning theme: it loads `granville-bridge-theme.css`, swaps in "bridge" versions of the BC logo, and replaces the top banner with a black alert: "ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of N" (age computed from 14 Nov 1948). It's the demise-of-the-Crown protocol, which explains the IGRS-approval warning. | bcgov/gcpe-news-webapp: `Views/Shared/_BlueBridgeBanner.cshtml`, `Views/Shared/_Layout.cshtml:79-162`, `Hubs/LiveHub.cs`, `Controllers/ApiController.cs` (`live/granville`) | 2026-10-03 (from public source code) |
