# Manual: when a new government takes office

For Core administrators (the **Core.Admin** role). Site editors and developers have one short part each. Operator-only notes are in their own section at the end.

**What changed.** Before, a new government meant about twenty manual steps: new archive pages, a crawler change, ministry renames and moves done by hand. Now the Hub does the dating, the archive and the redirects by itself. You enter one date and, where ministries change, run one guided hand-over.

## At a glance

| When | Who | What to do |
|---|---|---|
| Swearing-in date announced | Core administrator | **Government terms** > **Start new government term** > enter the date. |
| Before swearing-in | Core administrator | **Organizations** > **Cabinet change**: stage renames, new ministries and hand-overs, then schedule them for the swearing-in time. Until Cabinet change is available, do the hand-overs and renames on the day, one at a time (see "Ministry hand-over"). |
| Swearing-in day | Nobody | The term rolls over at 00:00 Pacific. The archive pages, the "current" link and the sitemap update themselves. A scheduled cabinet change publishes, old ministry web addresses start redirecting, and subscribers move. |
| After | Site editors | Minister photos and biographies, and the election banner (Website > site settings). Update the minister contact records in the Media Hub by hand. |
| Never again | Corporate Search, developers | No crawler change, no code edit, no SQL. |

## 1. Start a new government term

You need the **Core.Admin** role. Others do not see the **Government terms** menu item.

1. In the left menu, choose **Government terms**. You see a table titled "Government terms, newest first" with the columns Term, Dates, Status, Releases and Actions. Status is Current, Past, Scheduled or Undated.
2. Choose **Start new government term**. A form opens.
3. Enter the **Start date** (required): the first day of the new government, normally the swearing-in date. You may enter it weeks ahead. Optionally enter a **Name**. Leave the name empty unless you want one; the date range is written for you.
4. Choose **Continue**. The Hub asks you to confirm in plain words, for example "Start a new government term on November 20, 2028? The current term will end November 19, 2028. Releases published from that day are listed under the new term." Read the dates. **The start date decides where every release is listed in the archive**, so check it.
5. Choose **Confirm**. You see "Saved. The archive switches to the new term on {date}." If the date is today or earlier, you see "Saved. The new term is now the current term."

What happens next, with no action from you:

- Releases are placed by the Pacific-time calendar day they were first published. One published at 11:59 pm the day before the start date stays in the old term. One at 12:00 am on the start date is in the new term.
- Dates are never typed twice. A term runs until the day before the next one starts, so terms never overlap.
- The public archive at `/archive/terms/` gets a page for the new term, and `/archive/terms/current/` points at it. This happens at midnight Pacific on the start date, even if nothing is published that day. A brand-new term shows "Nothing has been published in this term yet." until the first release.

**Changing your mind.** In the table, **Edit** changes a term's date or name. **Delete** appears only on a scheduled term that has no releases. A term that has started cannot be deleted.

## 2. Ministry hand-over (successor ministry)

Use this when a ministry is replaced by another (merged, split or renamed into a new one). A simple rename needs no hand-over: edit the ministry's name on **Organizations**. Its web address, subscribers and history stay.

1. Open **Organizations**. On the old ministry (call it A), choose **Deactivate**. A panel titled "Deactivate A" opens. For an already inactive ministry, use **Set successor...** instead.
2. Under "Has a successor?", pick the ministry that takes over (B). You can pick more than one for a split.
3. The panel lists what will move, each as a tick box that is on by default. Untick anything you want to leave:
   - Send A's web pages to B (always on once a successor is set).
   - Move N subscribers to B.
   - Move N staff from A to B.
   - Move N upcoming Calendar activities and M contacts to B.
   - Move N draft releases to B. Approved and scheduled releases do not move; they are listed with links so you can deal with them.
   - Let B use A's abbreviation (only when B has none, or you confirm replacing it).
   If a number cannot be loaded you see "count unavailable". That does not stop you.
4. Choose **Deactivate and hand over**. You see "A is deactivated. Its pages now send visitors to B."

Notes for staff:

- The moves for subscribers, Calendar and drafts finish in the background, usually within a minute. The Hub's message does not promise they are done. If something looks unmoved after a few minutes, tell an operator (see Section 4).
- Old web addresses under `/ministries/A` now go permanently to `/ministries/B`. If B is later replaced too, A's address goes straight to the newest ministry.
- Undo: **Reactivate** on A stops the redirect. It does not move people back.
- Ministry abbreviations only need to be unique among active ministries, so B can take over A's abbreviation.

## 3. Cabinet change (after it is built)

**Organizations** > **Cabinet change** lets you stage everything for the swearing-in and publish it at once.

1. Choose **Add change** for each rename, new ministry or hand-over. One draft is open at a time.
2. Choose **Preview**. You see old and new side by side, the resulting ministry list, and the counts for each hand-over. The preview refuses a change that would clash on an abbreviation, leave a closed ministry with neither a successor nor "No successor" ticked, or create a loop.
3. Choose **Publish now**, or **Schedule...** and pick the swearing-in time.

If someone edits a ministry after you staged the change, publishing is refused and names that ministry. Reopen the draft and review it. Nothing is half-applied.

## 4. Operator-only notes

These are for the person who runs the servers, not for admin staff.

### One-time actions at cutover

- **Owner sign-off** that the Hub's archive by term replaces archive.news.gov.bc.ca for 2012 onward (decision record C1, question Q-NG1). The old archive stays online as the pre-2012 and pre-cutover archive.
- **Corporate Search ticket**, once: add the entry point `https://news.gov.bc.ca/archive/terms/` and the sitemap `https://news.gov.bc.ca/sitemap.xml`, with PDFs excluded. Keep the `archive.news.gov.bc.ca` domain for older content. Nothing changes per election after that.
- **Hub edit:** change the "News Archive" resource link to `/archive/terms/` (Website > resource links).
- **Coverage check** (below), clean, before the sign-off.

### Coverage check

Proves every release listed in the old archive is in the platform:

```
npx tsx scripts/archive-coverage-check.ts --news-api https://<news-api-host> \
  https://archive.news.gov.bc.ca/releases/index_2020-2024.htm [more index pages or saved files...]
```

It prints `checked N, missing M` and the missing keys, and exits 1 if any are missing. Exit 2 means a page or the API could not be read, which is not a pass. It makes at most one request a second (about 65 requests for the 6,304 keys of `index_2020-2024.htm`). Run it for every term's index page before cutover. Keys match without regard to capital letters.

### Checks for operators

1. **Undated terms.** After the NRMS migration, run:
   ```sql
   SELECT name, start_date FROM government_terms ORDER BY start_date NULLS FIRST;
   ```
   Any row with an empty `start_date` is an undated term: it never counts as current and is left out of the public archive. In the Hub (Government terms > **Edit**), give each one a start date.
2. **Time zone data.** Confirm the database and the app agree on Pacific time. Run in Postgres:
   ```sql
   SELECT (timestamptz '2028-11-20 06:59:00+00' AT TIME ZONE 'America/Vancouver');
   ```
   and in Node:
   ```js
   new Date('2028-11-20T06:59:00Z').toLocaleString('en-CA', { timeZone: 'America/Vancouver' })
   ```
   Both must show the same Pacific date and time. The date should be 2028-11-19. The clock time depends on the time-zone rules the host knows: 22:59 under ordinary winter time (UTC-8), 23:59 if the host's tzdata has British Columbia on permanent daylight time (UTC-7); on 2026-10-27 the developer's machine and its Postgres both gave 23:59. Why it matters: the database decides each release's term from its Pacific publish day and the app decides what the archive shows, so if the two disagree about Pacific time, a release published near midnight on a term's start date could be listed under the wrong term. If they differ, update the time-zone data (tzdata) on the older host before the election.
3. **Stuck moves.** If a hand-over's subscribers, Calendar activities or drafts have not moved after a few minutes, look for dead-lettered `org.succeeded` events (the Calendar dead-letters screen shows them). The moves are safe to run again.

### Resolving a wrong start date

Edit the term in the Hub. The archive pages and the "current" link rebuild on their own. No SQL is needed.

Decisions behind all of this are recorded in `docs/parity/changes-from-legacy.md` (C11 and the "new government" rows) and `docs/parity/open-questions.md` (Q-NG1 to Q-NG7).
