# URL cutover runbook

For the operator who moves `news.gov.bc.ca` from the legacy site to the Hub's public site. It covers what to check before the switch, what the owner must supply, the order of work on the day, and what is not built.

Built on `feat/parity-3`. Every batch is deployed to boxs.ca: A (PR #56), B and C (PR #58), D and E (the manage-link import and the rehearsal lists; PR #61, merged as 3d9e657, boxs.ca deploy 169a775). The final-review fixes are on `fix/parity-3-final`. The decisions behind the behaviour are C257-C272 in `changes-from-legacy.md`; the full list of legacy addresses is in `inputs/url-compat.md`.

## 1. Rehearsal

The rehearsal asks a host for each old address and reports whether it answers 200, or redirects once to a page that answers 200. A second redirect (a chain), a 404 or a 500 is a failure. It is a local tool; it is not part of CI.

Run it from the repo root. It waits one second between requests to news.gov.bc.ca and a fifth of a second for other hosts.

```
npm run parity:urls -- --base https://boxs.ca
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls.generated.txt
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls-ours.txt
```

The output has one line per address (`ok` or `FAIL`, status, where it redirects, the reason), then a pass count for each section, then the overall count. The exit code is 1 if anything failed.

| List | What it holds | Run against |
|---|---|---|
| `tools/parity/legacy-urls.txt` | Curated: every kind of old address, each checked to work on news.gov today. Sections: fixed rules, robots and verification, posts and case, long keys, ministries, references, feeds. | boxs.ca, then `https://news.gov.bc.ca` on cutover day |
| `tools/parity/legacy-urls.generated.txt` | 243 addresses read from the live site on 2026-10-28 (its home page, `/connect` and the HTML sitemap). Sections: nav, feeds, posts, post-variants. | boxs.ca, then `https://news.gov.bc.ca` on cutover day |
| `tools/parity/legacy-urls-ours.txt` | Rows that test our behaviour, not legacy's: the `/site` alias, and `/Ministries/Health`, which legacy answers 500 and we redirect. | boxs.ca only. Legacy fails these by design. |

`tools/parity/legacy-urls-pending.txt` holds `/live`, which waits for plan 4. It moves into `legacy-urls.txt` when that page ships.

### Reading failures by section

| Section | A failure usually means |
|---|---|
| fixed rules | A redirect rule is missing or wrong (`/more-news`, `/archive/<yyyy>`, `/sitemap/html`, `/contact`, `/newsletters`, `/search` variants). A code bug. |
| robots and verification | `robots.txt` is wrong, or the Google verification file is missing because `SITE_GOOGLE_VERIFICATION_FILE` / `SITE_GOOGLE_SITE_VERIFICATION` is not set on that host. |
| posts and case, posts, post-variants | The post is not imported on that host (data), or the case, kind or `/image` rule is wrong. |
| long keys | The post is not imported, or its folder has not been rendered. |
| ministries | The rename table, the Hub's successor records, or a page not built. A rename never redirects to a page that does not exist (C267, C271), so a missing page shows here as a 404. |
| references | The `/<digits>` NEWS-n link. The post is not imported or not published (C272). |
| feeds | A feed file has not been built, or the category does not resolve (C270). |
| nav | Pages the site builds: a missing static page, or plan 4 not shipped. |

The `posts`, `post-variants` and `references` rows, and the long-key row, depend on the post being imported on that host. A failure there on boxs.ca can be data, not a bug. Check by asking whether boxs.ca holds that post.

Failures expected on boxs.ca today are data only:
- The news.gov posts not imported there: `2026TT0105-001130`, the long-key post (the M17 key, 102 characters), and NEWS-34336.
- The Google verification file, until the verification token is set.

Any other failure is a bug and becomes a named fix task before plan 4.

## 2. Evidence the owner must supply (T9)

None of this can be got from the repo. Each item says what it changes.

| | Evidence | What it changes |
|---|---|---|
| a | 90 days of IIS or Kestrel logs. `RedirectMiddleware` writes `METHOD url` for each request. Rank the paths by hits, then run the top 500 through `parity:urls`. | Finds addresses nobody listed. The only way to know real traffic. |
| b | The production `RedirectMiddleware` source. The repo copy is behind production (P16): the live home page links ministries the repo's rules do not know. | Rename rules and successor records. Without it some renames stay unmapped. |
| c | A count of posts with `RedirectUri` set. | This plan does not redirect them. If there are many, they need their own rule. |
| d | The production key lists: ministries, sectors, themes, tags. | Diff against ours to find keys that would 404. |
| e | The production `AuthenticationTimeout`, and whether the bulk-email "Manage your subscription" link carries a per-subscriber token. Both are in the DB `Template` and `Site` tables. | How many old-email links `nod:import` can keep working. |
| f | ~~The legacy `/files` store, and whether it is publicly readable.~~ **Answered 2026-10-29:** the files are the legacy Hub's **Website > Files** uploads (legacy `News/FileManagement.aspx.cs`): the Azure container `files`, one blob per file under its lowercased name with metadata `filename` = the name as uploaded. Readable per file through legacy's front door (`https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/files/<name>`), not listable anonymously; listable with a read+list SAS. | Built: `legacy-files:copy` imports them as NRMS site files (Hub > Website > Files, served at `/files/<name>` in any case), and an unknown `/files/<path>` is 302'd to the front door (on by owner decision, 2026-10-29). See "Before the day (legacy /files)" below. |
| g | The DNS plan for `www.news.`, `newsroom.` and `enewsletters.gov.bc.ca`. | Whether section 4 is needed. |
| h | The time zone and clock of the machines that write legacy NoD's dates: the IIS server(s) running the NoD subscribe site and its services (`Gcpe.NewsOnDemand.Website` / `.Website.Services`, which write `SysLog.EventDate` and the manage links' `SubscriberLink.ExpiryDate`), and the host that runs the NoD sending task (`NodTask`, which stamps a manage link into every email). On each: the Windows time zone (`tzutil /g`) and whether the clock is synchronised (`w32tm /query /status`). Not the SQL Server: these dates are .NET `DateTime.Now` on the writing machine (`NewsOnDemandEventLogging.cs:88`, `SubscriptionProvider.cs:382/415/482`, `NodTask.cs:414`), stored as they are. | `nod:import` reads every legacy date as wall-clock time in the tenant zone (America/Vancouver). If a writer runs in UTC or another zone, unsubscribe and leave dates shift by hours, and so does which manage links count as unexpired. A re-run counts an unsubscribe as new if it is no more than an hour older than the previous import's start, which absorbs the hour repeated when DST ends (read an hour early) and small clock drift, not a wrong zone. Confirm before the final import. |

## 3. Cutover-day order

Do these in order. Stop if a step fails; the rehearsal at the end is the check.

**Before the day (install).** On the Windows server, turn off 8.3 short names on the volume that holds `C:\gcpe` and strip the ones already made there:

```
fsutil 8dot3name query C:
fsutil 8dot3name set C: 1
fsutil 8dot3name strip /t /s C:\gcpe\data
fsutil 8dot3name strip /s C:\gcpe\data
```

The `/t` run only lists what would change. Why both this and the code: the site rejects any address segment containing `~` or `:`, or ending in `.` or a space (C268), so `/SITE-S~1.JSO` or `/index.html::$DATA` is a 404 before the site's file server sees it. That check covers only the public site. `/files` (NRMS uploads, whose keys carry a random part, and whose `.meta` folder is refused as a dotfile) and `/hub` are served by their own file servers. On a volume with short names, `/files/<first six characters>~1.PDF` could open an upload without its random part, and `/files/META~1/` could reach `.meta`. Setting the volume flag removes that for every file server. `8dot3name set` affects the whole volume, so check with the server's owner that nothing else on it depends on short names. Not tested on Windows from here.

**Before the day (translation and media-asset links).** Legacy keeps each release's translation PDFs and media assets in Azure blob storage, which stays up after cutover; legacy SQL has no list of them, so the News API's legacy import leaves them out. `import:files` fills them in from the public legacy API, one request per release that legacy flags as having translations or media assets, newest first. The legacy survey puts that at no more than 4,539 (an upper bound: it counts unpublished rows and posts with both flags twice); `--dry-run` gives the real count and hours. Run it over the whole archive a few days before, after a News API legacy import (`Import-GcpeLegacy.ps1 -Only NewsApi`, or `npm --workspace @gcpe/news-api run import:legacy` from a checkout) that carries legacy's `HasTranslations` flag:

```
npm run news-api:import-files -- --dry-run          # count and hours; sends nothing
npm run news-api:import-files -- --concurrency 2    # at most about 40 minutes
```

On the servers, run the bundled `tools/news-api-import-files.mjs` instead (siteground.md and windows.md, "Legacy translations and media assets"). A later legacy import keeps what it filled, as long as legacy still sets the post's flag (a cleared flag clears that list). Check the report: `remaining` 0 and `stopped` null. If it stopped on a 429, wait an hour and run the same command again; it skips the posts already filled. A few `notFound` keys are posts legacy has unpublished since. Spot-check one release with translations (for example `/releases/2026HLTH0085-001117`): its PDFs link to `https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/translations/…` and download.

**Before the day (legacy /files).** `https://news.gov.bc.ca/files/<name>` are the files staff uploaded in the legacy Hub's Website > Files screen; legacy bodies link them, and `/assets/license` redirects to `/files/News_Footage_License_British_Columbia.pdf`. `legacy-files:copy` imports them as **NRMS site files**: afterwards they are listed in our Hub under **Website > Files** (dated with the legacy upload time, created by "Legacy import") and staff manage them like any upload. After DNS moves the stack answers `/files/<path>`: NRMS's own file first (release files only while live, Q17; `releases/` and `slides/` are never anything else), then a site file of that name in any letter case, then a `302` (no-store) to `https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/files/<path, lowercased>`. The 302 is **on by owner decision (2026-10-29)**, relying on legacy's Azure storage staying up after cutover: Q72 says so for translations and media assets, and this container is on the same front door (assumed the same account; confirm if Azure is ever to be retired). Turn it off with `LEGACY_FILES_FALLBACK=false` (the site's 404 instead); it is a 302 so it can be withdrawn. Anything that isn't an inert type (PDF, images other than SVG, office documents, archives, audio/video, text) is served as a download with a sandbox CSP, never rendered on news.gov.bc.ca. A Hub upload with an imported file's name asks to replace it, and the replace keeps the legacy URL.

**Get a read + list SAS URL for the legacy `files` container** from whoever holds the legacy Azure storage account (the legacy Hub's configuration holds a container SAS; ask for a fresh, short-lived read+list one) and give it to the tool as `LEGACY_FILES_SAS_URL`. With it the whole container is listed and every Hub upload imported by its exact blob name and its original name. Without it the tool falls back to the files our content links to (plus `--paths-file` / `--scan-file`, for example IIS logs, 2a), fetched lowercased-first through the front door. Run it **after the final content imports and before DNS moves**, then a catch-up run after the last import (it skips names already imported, so it is cheap):

```
npm run legacy-files:copy -- --dry-run          # files, total bytes, already imported; downloads nothing
npm run legacy-files:copy -- --concurrency 2    # import
npm run legacy-files:copy                       # catch-up after the last import
```

On the servers run `tools/legacy-files-copy.mjs` with the stack's `NRMS_DATABASE_URL` and `DATA_DIR`, and `LEGACY_FILES_SAS_URL` (siteground.md and windows.md, "Legacy /files import"). Check the report: `remaining` 0, `stopped` null, `failed` empty; `nested` lists blobs with a `/` (not Hub uploads; the 302 covers them); without a SAS, `notFound` lists links legacy itself answers 404 for (broken today). **Verify:** the files appear in the Hub under Website > Files; `curl -sI https://<host>/files/News_Footage_License_British_Columbia.pdf` answers **200 `application/pdf`, not a 302**, and `/assets/license` lands on it; a `/files/` link from an imported release downloads.

The licence check matters: the 302 goes to the **lowercased** name (how the legacy Hub stores uploads; 46 of 46 mixed-case links surveyed on 2026-10-29 answered only lowercased), so a blob that exists only under a mixed-case name, as the footage licence does, is reachable only if the import succeeded. A 302 for it means the import missed it. A no-SAS dry run over 800 recent public posts (200 each of releases, stories, factsheets and updates; 2026-10-29) found 47 distinct linked files (plus the licence) and no refused references; all 47 exist on Azure.

Then, **after the last legacy import of News API posts** (the final `Import-GcpeLegacy.ps1 -Only NewsApi` before legacy stops publishing) and **before DNS moves** (step 6; it reads `api.news.gov.bc.ca`, which must still be legacy's), catch up in two runs:

```
npm run news-api:import-files                                   # flagged posts not filled yet: the new ones (cheap)
npm run news-api:import-files -- --refresh --since <full-run date minus 30 days>   # recent posts again
```

A plain run (no `--since`, no `--refresh`) asks only for flagged posts whose lists are still empty, so it picks up every post published or newly flagged since the full run, but it never revisits a post it already filled. The `--refresh --since` run asks again for the recent posts, which is where legacy staff still add or remove translations; a changed list is rewritten, an unchanged one is not. Older posts are not revisited by either run: if legacy staff are known to have changed files on an older release, or to be safe once, run `--refresh` with a wider `--since` (or `--all`) before DNS moves; it is idempotent.

1. **Freeze legacy subscription writes.** Put the legacy subscribe and manage pages, and the NoD admin's subscriber screens, into maintenance or read-only. From here on legacy takes no new subscribes, preference changes or unsubscribes; anyone who tries is told to come back shortly, and after DNS moves they reach the Hub.
2. **Stop legacy NoD sending**, so no new manage links are made on the old system.
3. **Run the final import:** `npm run nod:import`. It copies the manage links still unexpired, so the last day's emails keep working (C266). Links older than the production timeout are not revived; they land on "request a new link". Read the report: if it lists "changed while importing: run the import again", run it again.
4. **Set the public site URL** to the origin (`https://news.gov.bc.ca`, no path): in the stack's `gcpe.env` that is `SITE_PUBLIC_SITE_URL` and `NOD_PUBLIC_SITE_URL` (the stack hands each app its own settings under a prefix). Restart the `gcpe-stack` service. The base URL is part of every page, so this queues a rebuild of the whole site (rebuild.ts `chromeChanges`). Wait for it to finish before DNS and the rehearsal. `/stack/health` does not show it: it reports only that each app is up. The signal is the public site's rebuild queue, in its database (`gcpe_site`):
   ```sql
   SELECT priority, count(*), max(attempts) FROM rebuild_queue GROUP BY 1;
   ```
   It is done when this returns no rows. It drains about `SITE_REBUILD_BATCH` pages (200 by default; set as `SITE_SITE_REBUILD_BATCH` in the stack's `gcpe.env`) per tick, one tick a minute, so a site of 100,000 posts takes about eight hours: change the URL the day before if you can. Rows that stay with `attempts` above 3 are pages that keep failing; look at them (`SELECT page_id, attempts FROM rebuild_queue WHERE attempts > 3;`) rather than waiting. Pages not yet rebuilt still link to `/site/…`, which redirects once to the root, so nothing breaks while it drains.
5. **Set `SITE_GOOGLE_VERIFICATION_FILE` and `SITE_GOOGLE_SITE_VERIFICATION`.** The next start notices the change and rebuilds only the static pages (which write the verification file) and home (which carries the meta tag), not the whole site. Then check `/google790b0529c8dcfaff.html` and the home page's `google-site-verification` meta tag.
6. **Switch DNS.**
7. **After the old record's TTL has passed, run `npm run nod:import` once more.** Anything that still reached legacy after the freeze (a page the maintenance switch missed, a staff change) is picked up. Verified in the import code and its tests (`apps/nod/src/import/subscribers.ts`, `subscribers.test.ts`): a re-run applies every legacy unsubscribe made since the previous import.
   - A record NoD has not changed since the last import takes legacy's state: it ends, its lists are cleared, and the unsubscribe is kept as history at its own date.
   - A record NoD has changed is ended as a NoD unsubscribe would end it, unless NoD holds newer consent: the person subscribed or resubscribed in NoD, or staff activated them, after the legacy unsubscribe.
   - A record legacy has since purged (its unsubscribe stays in SysLog) is ended the same way.
   - A record NoD has purged is kept as an every-media-list opt-out, so staff are asked before re-adding the address.
   - "Since the previous import" means no more than an hour before that run's start, so an unsubscribe made while a run was importing counts, as does one in the hour repeated when DST ends. An unsubscribe already applied is not applied again over a later re-add in NoD.
   - Someone who unsubscribed in legacy and signed up again has a new legacy record (legacy finds a record by address only while it isn't deleted). If that record is active and registered after NoD's record of the address last ended, it takes the address over in NoD with its own lists, and the old record's history (the unsubscribe included) moves onto it. Media lists the person opted out of still need staff to confirm a re-add. An end in NoD newer than the sign-up is never undone.
   - A re-run never brings back a record NoD ended or purged. A NoD change wins over legacy's older state, and a purged record is not re-inserted. It never revives a manage link NoD ended either: a link whose legacy address is no longer the NoD record's is skipped.

   The report says what it ended: "unsubscribed in legacy since the last import (NoD's record ended)", and a note for purged records.

   One gap, from legacy's own code (`SubscriptionProvider.UnsubscribeSubscriber`): legacy logs an unsubscribe (SysLog 104) only when the subscriber was enabled. A disabled subscriber's unsubscribe only marks the record deleted, and a re-run applies that only to a record NoD has not changed. Such a record is disabled in NoD too, so it is not being sent mail.
8. **Run the rehearsal** against the live name, using the generated list as well:
   ```
   npm run parity:urls -- --base https://news.gov.bc.ca
   npm run parity:urls -- --base https://news.gov.bc.ca --list tools/parity/legacy-urls.generated.txt
   ```
   Expect everything to pass. Do not run `legacy-urls-ours.txt` here.

Keep legacy read-only (not deleted) until step 7 has run.

## 4. Other hosts (T8, not built)

Only needed if DNS moves for these names.

- `www.news.gov.bc.ca` needs a 301 to the apex. This is a small host check placed ahead of `legacyUrls` in the stack.
- `newsroom.gov.bc.ca` needs the legacy `RedirectFromNewsroom` rules. These include `/subscribe.aspx?guid=…`, which the main host already handles.
- `enewsletters.gov.bc.ca` is not built either; the legacy middleware handles it the same way.

`archive.news.gov.bc.ca` is a separate host and stays as it is.

## 5. Not covered

- Posts with `RedirectUri` (2c).
- Old ministries with no page and no successor, such as `environment-and-climate-change-strategy`, which is a 404 on live today. Owner question 5.
- `/live`, until plan 4 ships it.

## 6. Gate results

Run on 2026-10-28 against boxs.ca, after batches D and E were deployed.

Commands:

```
npm run parity:urls -- --base https://boxs.ca
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls.generated.txt
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls-ours.txt
```

Expected: 100% on the first. On the second, 100% except the `posts` and `post-variants` rows for posts boxs.ca does not hold; list each below with the reason. On the third, 100%.

| Run | Date | Deployed commit | Result | Failures and reasons |
|---|---|---|---|---|
| `legacy-urls.txt` | 2026-10-28 | 3d9e657 (boxs.ca deploy 169a775) | 34/41. Sections: default 9/9, fixed rules 8/8, ministries 7/7, feeds 8/8. | All data or config: the Google verification token is not set on boxs.ca; news.gov posts not imported there: `2026TT0105-001130` (each row that uses it), the M17 long-key post, NEWS-34336. |
| `legacy-urls.generated.txt` | 2026-10-28 | 3d9e657 (boxs.ca deploy 169a775) | 74/243. Sections: nav 34/34, feeds 40/40, posts 0/149, post-variants 0/20. | posts and post-variants: all are news.gov posts boxs.ca does not hold (data). |
| `legacy-urls-ours.txt` | 2026-10-28 | 3d9e657 (boxs.ca deploy 169a775) | 4/4 | None. |

The final review also probed a post boxs.ca does hold, `2026HLTH0005-000008`: the wrong case, `/stories/` in upper case, `/updates/…/`, `/image` and `/site/Releases/…` each reached the page in one hop.

Any other failure becomes a named fix task before plan 4.

## 7. Questions for the owner

1. **Manage links.** What is production NoD's `AuthenticationTimeout`? Does the bulk-email "Manage your subscription" link carry a per-subscriber token? Both live in the DB templates. The answers set how many old-email links can be saved.
2. ~~**`/files/*`.** Is the legacy files store publicly readable?~~ Answered: they are the legacy Hub's uploaded files, readable per file and listable with a SAS (2f). Built: the import into site files plus the 302 safety net, on by owner decision (2026-10-29). Still open: who issues the read+list SAS for the `files` container, and does that container stay up indefinitely (Q72 covered translations and media assets)?
3. **DNS** for `www.news.gov.bc.ca`, `newsroom.gov.bc.ca` and `enewsletters.gov.bc.ca` (T8). Old NoD templates link `newsroom.gov.bc.ca/subscribe.aspx?guid=…`.
4. **The evidence in section 2**: access logs, the production redirect source, the `RedirectUri` post count and the key lists.
5. **Old ministries with no page and no successor** (for example `environment-and-climate-change-strategy`). Should the Hub give them successor records so their links land somewhere instead of the 404?
6. **robots `/files`.** Keep legacy's Disallow, as planned, or let release PDFs be indexed?
7. **Time zone and clock of legacy NoD's web/app server(s) and the NodTask host** (2h), not the SQL Server: they write the dates. The import reads them as America/Vancouver wall-clock time. Confirm each machine's zone, and that its clock is synchronised, before the final import.
