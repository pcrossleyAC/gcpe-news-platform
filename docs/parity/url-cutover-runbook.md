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
| f | The legacy `/files` store (Azure `files` container or the UNC share), and whether it is publicly readable. | If readable, an unknown `/files/<path>` can fall back to a 302 there. If not, the files must be imported (`nrms:import-files`, Q13) before DNS moves. Blocking if imported posts link to files. |
| g | The DNS plan for `www.news.`, `newsroom.` and `enewsletters.gov.bc.ca`. | Whether section 4 is needed. |
| h | The legacy SQL Server's time zone (`SELECT SYSDATETIMEOFFSET()` on the NewsOnDemand server) and how far its clock is from the Hub's. | `nod:import` reads every legacy date (`SysLog.EventDate`, `SubscriberLink.ExpiryDate`) as wall-clock time in the tenant zone (America/Vancouver). If the server runs in UTC or another zone, unsubscribe and leave dates shift by hours, and so does which manage links count as unexpired. A re-run compares an unsubscribe's date with the previous import's start, so a legacy clock running behind the Hub's can make an unsubscribe made just after an import look older than it. Confirm before the final import. |

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

1. **Freeze legacy subscription writes.** Put the legacy subscribe and manage pages, and the NoD admin's subscriber screens, into maintenance or read-only. From here on legacy takes no new subscribes, preference changes or unsubscribes; anyone who tries is told to come back shortly, and after DNS moves they reach the Hub.
2. **Stop legacy NoD sending**, so no new manage links are made on the old system.
3. **Run the final import:** `npm run nod:import`. It copies the manage links still unexpired, so the last day's emails keep working (C266). Links older than the production timeout are not revived; they land on "request a new link". Read the report: if it lists "changed while importing: run the import again", run it again.
4. **Set `PUBLIC_SITE_URL`** to the origin (`https://news.gov.bc.ca`, no path) and restart. The base URL is part of every page, so this queues a rebuild of the whole site (rebuild.ts `chromeChanges`). Wait for it to finish before DNS and the rehearsal. `/stack/health` does not show it: it reports only that each app is up. The signal is the public site's rebuild queue, in its database (`gcpe_site`):
   ```sql
   SELECT priority, count(*), max(attempts) FROM rebuild_queue GROUP BY 1;
   ```
   It is done when this returns no rows. It drains about `SITE_SITE_REBUILD_BATCH` pages (200 by default) per tick, one tick a minute, so a site of 100,000 posts takes about eight hours: change the URL the day before if you can. Rows that stay with `attempts` above 3 are pages that keep failing; look at them (`SELECT page_id, attempts FROM rebuild_queue WHERE attempts > 3;`) rather than waiting. Pages not yet rebuilt still link to `/site/…`, which redirects once to the root, so nothing breaks while it drains.
5. **Set `SITE_GOOGLE_VERIFICATION_FILE` and `SITE_GOOGLE_SITE_VERIFICATION`.** The next start notices the change and rebuilds only the static pages (which write the verification file) and home (which carries the meta tag), not the whole site. Then check `/google790b0529c8dcfaff.html` and the home page's `google-site-verification` meta tag.
6. **Switch DNS.**
7. **After the old record's TTL has passed, run `npm run nod:import` once more.** Anything that still reached legacy after the freeze (a page the maintenance switch missed, a staff change) is picked up. Verified in the import code and its tests (`apps/nod/src/import/subscribers.ts`, `subscribers.test.ts`): a re-run applies every legacy unsubscribe made since the previous import.
   - A record NoD has not changed since the last import takes legacy's state: it ends, its lists are cleared, and the unsubscribe is kept as history at its own date.
   - A record NoD has changed is ended as a NoD unsubscribe would end it, unless NoD holds newer consent: the person subscribed or resubscribed in NoD, or staff activated them, after the legacy unsubscribe.
   - A record legacy has since purged (its unsubscribe stays in SysLog) is ended the same way.
   - A record NoD has purged is kept as an every-media-list opt-out, so staff are asked before re-adding the address.
   - "Since the previous import" means at or after that run's start, so an unsubscribe made while a run was importing counts.
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
- `/files/*` (2f).
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
2. **`/files/*`.** Is the legacy files store publicly readable? If it is, a fallback 302 for an unknown `/files/<path>` is trivial. If not, an import (Q13) must land before DNS moves.
3. **DNS** for `www.news.gov.bc.ca`, `newsroom.gov.bc.ca` and `enewsletters.gov.bc.ca` (T8). Old NoD templates link `newsroom.gov.bc.ca/subscribe.aspx?guid=…`.
4. **The evidence in section 2**: access logs, the production redirect source, the `RedirectUri` post count and the key lists.
5. **Old ministries with no page and no successor** (for example `environment-and-climate-change-strategy`). Should the Hub give them successor records so their links land somewhere instead of the 404?
6. **robots `/files`.** Keep legacy's Disallow, as planned, or let release PDFs be indexed?
7. **Legacy SQL Server time zone and clock** (2h). The import reads legacy dates as America/Vancouver wall-clock time. Confirm the server's zone, and that its clock is close to the Hub's, before the final import.
