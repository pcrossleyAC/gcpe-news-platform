# URL cutover runbook

For the operator who moves `news.gov.bc.ca` from the legacy site to the Hub's public site. It covers what to check before the switch, what the owner must supply, the order of work on the day, and what is not built.

Built on `feat/parity-3`. Batch A is live on boxs.ca (PR #56), batches B and C too (PR #58). Batches D and E (the manage-link import and the rehearsal lists) are on the branch and not yet deployed. The decisions behind the behaviour are C257-C272 in `changes-from-legacy.md`; the full list of legacy addresses is in `inputs/url-compat.md`.

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
| `tools/parity/legacy-urls-ours.txt` (coming) | Rows that test our behaviour, not legacy's: the `/site` alias, and `/Ministries/Health`, which legacy answers 500 and we redirect. | boxs.ca only. Legacy fails these by design. |

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

## 3. Cutover-day order

Do these in order. Stop if a step fails; the rehearsal at the end is the check.

1. Stop legacy NoD sending, so no new manage links are made on the old system.
2. Run the final import: `npm run nod:import`. It copies the manage links still unexpired, so the last day's emails keep working (C266). Links older than the production timeout are not revived; they land on "request a new link".
3. Set `PUBLIC_SITE_URL` to the origin (`https://news.gov.bc.ca`, no path). The site then builds with no `/site` prefix.
4. Set `SITE_GOOGLE_VERIFICATION_FILE` and `SITE_GOOGLE_SITE_VERIFICATION`. Changing them queues no rebuild by itself; check `/google790b0529c8dcfaff.html` and the page's meta tag after the next render.
5. Switch DNS.
6. Run the rehearsal against the live name, using the generated list as well:
   ```
   npm run parity:urls -- --base https://news.gov.bc.ca
   npm run parity:urls -- --base https://news.gov.bc.ca --list tools/parity/legacy-urls.generated.txt
   ```
   Expect everything to pass. Do not run `legacy-urls-ours.txt` here.

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

The controller fills this in after batches D and E are deployed to boxs.ca. Do not fill it in before.

Commands:

```
npm run parity:urls -- --base https://boxs.ca
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls.generated.txt
npm run parity:urls -- --base https://boxs.ca --list tools/parity/legacy-urls-ours.txt
```

Expected: 100% on the first. On the second, 100% except the `posts` and `post-variants` rows for posts boxs.ca does not hold; list each below with the reason. On the third, 100%.

| Run | Date | Deployed commit | Result | Failures and reasons |
|---|---|---|---|---|
| `legacy-urls.txt` | | | | |
| `legacy-urls.generated.txt` | | | | |
| `legacy-urls-ours.txt` | | | | |

Any other failure becomes a named fix task before plan 4.

## 7. Questions for the owner

1. **Manage links.** What is production NoD's `AuthenticationTimeout`? Does the bulk-email "Manage your subscription" link carry a per-subscriber token? Both live in the DB templates. The answers set how many old-email links can be saved.
2. **`/files/*`.** Is the legacy files store publicly readable? If it is, a fallback 302 for an unknown `/files/<path>` is trivial. If not, an import (Q13) must land before DNS moves.
3. **DNS** for `www.news.gov.bc.ca`, `newsroom.gov.bc.ca` and `enewsletters.gov.bc.ca` (T8). Old NoD templates link `newsroom.gov.bc.ca/subscribe.aspx?guid=…`.
4. **The evidence in section 2**: access logs, the production redirect source, the `RedirectUri` post count and the key lists.
5. **Old ministries with no page and no successor** (for example `environment-and-climate-change-strategy`). Should the Hub give them successor records so their links land somewhere instead of the 404?
6. **robots `/files`.** Keep legacy's Disallow, as planned, or let release PDFs be indexed?
