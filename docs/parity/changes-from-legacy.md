# Changes from legacy NRMS

Where the new NRMS deliberately behaves differently from the legacy system (`gcpe-hub-develop/Hub.Legacy`). Everything not listed here is meant to match legacy. Each change says what legacy does, what we do instead, and why, so it can be challenged or reversed.

Status key: **Agreed** (approved in design) · **Proposed** (in a design section not yet approved) · **Reversed** (we went back to legacy behaviour; keep the row for the record).

## Sign-in, users and roles

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C1 | Windows/SiteMinder sign-in; one check (role "Advanced" or higher) for the whole News module. | Core holds users and roles (NRMS.Editor, NRMS.SiteEditor, NRMS.Viewer, Core.Admin) and signs everyone in; Entra plugs in later. | Legacy's sign-in depends on government Windows infrastructure we can't run; finer roles let site editors and read-only users exist. NRMS.Editor keeps legacy's "Advanced" powers, and there's still no per-ministry restriction, as in legacy. | Agreed |
| C2 | Background publisher's log entries have no user. | Every log entry has an actor; the publisher is logged as "system". | Every entry says who did it. | Agreed |

## Releases and the publish workflow

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C3 | Status is a mix of on/off flags (committed, published, active…). | One status: Draft → Approved → Scheduled → Publishing → Published, plus Unpublishing, Failed, Deleted. | The flag combinations were hard to reason about (e.g. "published but not committed" means "unpublishing"). Same screens and wording result. | Agreed |
| C4 | Release numbers come from "highest existing + 1", with no locking; `NEWS-` numbers are compared as text. | Numbers come from a counter table locked inside the approve transaction. | Two people approving at once could get the same number. | Agreed |
| C5 | The year in the release number comes from the server's clock. | The year is BC local time. | A release approved late on 31 December shouldn't get next year's number. | Agreed |
| C6 | Publishing does every step in one go with no undo; if a later step fails (e.g. a file copy), the release is marked published and never retried. | Each follow-up step (News API, site rebuild, NoD, media lists, Flickr) is its own retried job. | Stops one outage from leaving a release half-published for good. | Agreed |
| C7 | A release with an empty body in any language is silently skipped by the publisher, forever, with no error shown. | Empty bodies are refused when you press Publish, with a message. | The legacy behaviour looks like a stuck release with no explanation. | Agreed |
| C8 | Almost all validation runs only in the browser; some "server checks" are debug-only asserts that do nothing in production. | Validation runs on the server, with the same rules shown in the form. | Anything calling the API directly bypassed every rule. | Agreed |
| C9 | If two people edit the same release, the later save silently wins. | The second save is refused ("someone else changed this, reload"). | Silent overwrites lose work. | Agreed |
| C10 | `NewsReleaseHistory` (published copies) exists but the current code never writes to it. | A frozen copy of the content is saved every time a release is published or corrected. | Gives a real "as published on…" history. | Agreed |
| C11 | Current government term is picked by sorting term names as text. | An explicit "current term" setting. | Text sorting breaks for some names (e.g. a term starting "2101-"). | Agreed |
| C12 | Page images that shouldn't be offered are hidden by two ids hard-coded in the code. | Page images have an "active" flag. | Hiding images shouldn't need a code change. | Agreed |
| C35 | Release keys (the address of a story, factsheet, etc.) are unique per type, so a Story and a Factsheet can share one. | Keys are unique across all types, ignoring case; a clash gets `-1`, `-2`, …. | The public News API addresses posts by key alone, so two posts with one key would overwrite each other on the site. | Agreed |

## Staff app screens

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C13 | Drafts and Scheduled lists load everything (no paging). | Every list is paged. | Keeps lists fast as numbers grow. | Agreed |
| C14 | Search never shows drafts. | Search includes drafts. | Drafts are often what people are looking for. | Agreed |
| C15 | Forecast tab and its calendar (iCal) feed. | Not built yet. Comes with the Corporate Calendar phase. | Needs Calendar data that doesn't exist yet. | Agreed (deferred) |
| C16 | Empty dashboard, non-working Email page, Lync presence icon (IE-only), spell-check dictionary stub (always returns "kwijibo"), mobile/desktop switch. | Not built. | None of them work in legacy. | Agreed |
| C17 | PDF produced by a Windows report engine (RDLC). | PDF produced by a JavaScript PDF library, laid out to look like legacy's. | RDLC is Windows-only; headless Chrome is a large download that's untested on SiteGround. | Agreed |
| C18 | Body HTML cleaned by string replacement against an allow-list. | Editor can only produce the allowed elements, and the server cleans again with the same allow-list (links, paragraphs, lists, bold, line breaks). | Same result; harder to bypass. | Agreed |

## Website section

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C19 | Slides are shared between carousels and copied on edit. | Each carousel has its own slides. | Simpler, and editing one carousel can't affect another. | Agreed |
| C20 | Slide image type guessed from its first byte; no size limit. | Type checked from the file's actual contents; 2 MB limit. | The one-byte guess can mislabel images. | Agreed |
| C21 | Scheduling the next carousel silently unpins the emergency slide. | Emergency pins stay up until someone unpins them. | An emergency notice shouldn't disappear as a side effect. | Agreed |
| C22 | Resource links have no screen; their table's key is the sort position. | Simple editor; each link has its own id. | Reordering shouldn't renumber keys. See open question Q3. | Agreed |
| C23 | Website changes aren't logged. | Every change records who made it. | Accountability for public-facing changes. | Agreed |
| C24 | Separate code paths for Azure Blob and local-disk file storage. | One storage interface (local folder now, cloud storage later). | One code path to test. | Agreed |
| C25 | Top/Feature slots only visible one release at a time. | Read-only "what's featured where" page. | Site editors can see every slot at once. | Agreed |
| C33 | Any "Advanced" user can turn on Project Blue Bridge after a browser confirm box. | Core.Admin only, after typing a confirmation phrase; every change logged and emailed to admins; off production the banner says "TEST —". | Turning it on announces the King's death on BC Gov News; see Q2, Q15. | Agreed |
| C39 | Production vs. test is decided by the hosting environment's name. | A site is treated as a test site (TEST banner, noindex) unless it's the real production deployment: `NODE_ENV=production` **and** not `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` **and** not `SITE_ENVIRONMENT=test`. | boxs.ca runs with `NODE_ENV=production`, and a test site must never look like a real announcement or be indexed. | Agreed (spec §6.4 intent) |
| C40 | N/A — not established from a legacy source. | Top/Feature can be set only on a published release; unpublishing or deleting that release empties its slots. | A slot pointing at a missing post breaks the home page. | Proposed; see Q18 |
| C41 | N/A — not established from a legacy source. | General files are named by their sanitised name with an extension forced to match their content; a duplicate name needs `replace=true`. | Stable public URLs (`/files/<name>`) and no silent overwrite. | Proposed |

## Media and Flickr

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C26 | The Flickr photo is only made public if the publisher runs in the exact minute of the publish time. | It's made public whenever the release actually goes out, even if late. | A late run left the photo private on a live release. | Agreed |
| C27 | If Flickr sign-in fails, "make public" silently does nothing and the release goes out with a private (broken) photo; nobody is told. | After making it public we ask Flickr again to confirm; anything other than "public" counts as a failure. | Closes the one silent failure in legacy's Flickr code. | Agreed |
| C28 | On any Flickr error the photo link is wiped from the release for good and an email asks staff to re-add it. | The release waits up to 2 minutes (one grace period) for the photo to go public; if it still hasn't, the release goes out without it, the link is kept, an alert shows in the staff app (and email), and the job keeps retrying every 5 minutes for 24 hours — the moment it succeeds the release is automatically re-published with the photo. | Release timing matters more than the photo, but nobody should have to re-add it by hand. | Agreed |
| C29 | Signs in to Flickr again before every call; checks Flickr's status page before every call. | Signs requests with the stored access token; no status-page check; retries with back-off. | Fewer calls, less exposure to rate limits; the status-page id is hard-coded and fails open anyway. | Agreed |
| C30 | Access token was obtained once by hand and pasted into config. | A one-time command (`flickr:authorize`) does the sign-in and prints the token to put in the environment. | Re-issuing the token shouldn't need a developer. | Agreed |
| C31 | Page images resized on every request. | Images served as uploaded; the browser scales thumbnails. | Small, fixed set of images; avoids a native image library on SiteGround. | Agreed |
| C32 | Uploads sent in 4 MB chunks (an Azure Blob requirement); translation file type forced to PDF without checking. | Single upload with a size limit; file contents checked (a PDF must really be a PDF). | Chunking only existed for Azure; checking contents stops mislabelled files. | Agreed |
| C34 | Body embeds resolved through Flickr's oEmbed over plain HTTP. | HTTPS. | No reason to send it unencrypted. | Agreed |
| C38 | N/A — legacy's behaviour here isn't established either way (see Q17). | A release's translation PDFs and media files are downloadable at their unguessable `/files/<key>` URL from the moment they're uploaded — including on a draft, before approval, and before an embargoed release's go-live (`addReleaseFile` in `apps/nrms/src/media/files.ts` checks the file's type, not the release's status). Nothing is guessable or listable: the key is a 64-bit random value plus the release's UUID. | Simpler than gating uploads/downloads on release status, and matches the legacy-style "already-published" case (Q17) uniformly; the risk is a leak of embargoed media to anyone who already has the link, not a stranger guessing it. | Proposed |

## Operations

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C36 | N/A — legacy isn't deployed this way. | Uploaded files and the public site's built output live in one `DATA_DIR` folder, outside any per-deploy folder, so a redeploy (which unpacks into a brand-new folder on SiteGround) doesn't lose either. | Before this, every deploy's new folder started with an empty site output, 404ing every public page until something rebuilt it. Not a legacy behaviour change — fixes a defect introduced by Phase 2's own deploy shape. | Agreed |
| C37 | N/A — legacy isn't deployed this way. | At startup, the public site rebuilds its home page and latest posts from the News API if its output folder has no `index.html` (self-heal), without blocking or failing startup if the News API isn't reachable yet. | A second line of defence against the same failure (`DATA_DIR` pointed somewhere new, or emptied) surfacing as public 404s instead of being fixed automatically. Not a legacy behaviour change. | Agreed |
