# Manual: when a new government takes office

For Core administrators (the **Core.Admin** role). Site editors and developers have one short part each. Operator-only notes are in their own section at the end.

**What changed.** Before, a new government meant about twenty manual steps: new archive pages, a crawler change, ministry renames and moves done by hand. Now the Hub does the dating, the archive and the redirects by itself. You enter one date and, where ministries change, run one guided hand-over.

## At a glance

| When | Who | What to do |
|---|---|---|
| Swearing-in date announced | Core administrator | **Government terms** > **Start new government term** > enter the date. |
| Before swearing-in | Core administrator | **Organizations** > **Cabinet change**: stage renames, new ministries and hand-overs, preview them, then schedule them for the swearing-in time (see "Cabinet change"). A single hand-over can also be done on its own from **Organizations** (see "Ministry hand-over"). |
| Swearing-in day | Nobody | The term rolls over at 00:00 Pacific. The archive pages, the "current" link and the sitemap update themselves. A scheduled cabinet change publishes, old ministry web addresses start redirecting, and subscribers move. |
| After | Site editors | Minister photos and biographies, and the election banner (Website > Banner). Update the minister contact records in the Media Hub by hand. |
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

**Changing your mind or fixing a wrong date.** In the table, **Edit** changes a term's start date, name and old-archive web address. If you change the start date of a term that has already started, the Hub asks you to confirm first, because releases move between terms. After you save, the archive pages and the "current" link rebuild on their own. No SQL is needed. **Delete** appears only on a scheduled term that has no releases. A term that has started cannot be deleted.

## 2. Ministry hand-over (successor ministry)

Use this when a ministry is replaced by another (merged, split or renamed into a new one). A simple rename needs no hand-over: edit the ministry's name on **Organizations**. Its web address, subscribers and history stay. To change several ministries at once for a new cabinet, use **Cabinet change** (Section 3) instead.

1. Open **Organizations**. On the old ministry (call it A), choose **Deactivate**. A panel titled "Deactivate A" opens. For a ministry that is already inactive (tick **Show inactive organizations** to see it), choose **Set successor…** instead; the panel is titled "Set successor for A".
2. In **Has a successor?** (or **Successor**), choose the ministry that takes over (B). For a split, choose **Add another successor** and pick the next one. Subscribers are added to every successor; the web pages, staff, Calendar and draft releases go to the first.
3. Under "What moves to B", each line is a tick box, on by default. Untick anything you want to leave with A:
   - Send A's web pages to B. Always on: this is what setting a successor does.
   - Move N subscribers to B (and any other successors).
   - Move N staff from A to B.
   - Move N upcoming Calendar activities and M comm contacts to B.
   - Move N draft releases to B. Releases that are already approved or scheduled do not move; they are listed with links so you can change their lead ministry yourself.
   - Let B use the abbreviation HLTH (A's abbreviation). This appears when A has an abbreviation and B has none. If B has its own, first tick "Replace B's abbreviation … with HLTH".
   While a count loads it says "counting…". If it cannot be loaded you see "count unavailable". That does not stop you.
4. Choose **Deactivate and hand over** (or **Set successor** for an inactive ministry). While it saves, the other buttons on the page wait. You then see "A is deactivated. Its pages now send visitors to B. Moves to other services finish shortly."

If you choose no successor, the button is just **Deactivate** and nothing moves.

If another active ministry already uses A's abbreviation, the Hub says so by name: untick "Let B use the abbreviation …" or change that ministry's abbreviation first.

Notes for staff:

- The moves for subscribers, Calendar and drafts finish in the background, usually within a minute. The Hub's message does not promise they are done. If something looks unmoved after a few minutes, tell an operator (see Section 4).
- Old web addresses under `/ministries/A` now go permanently to `/ministries/B`. If B is later replaced too, A's address goes straight to the newest ministry. A ministry that is already inactive can't be chosen as a successor, so a hand-over back to A is refused.
- Undo: **Reactivate** on A stops the redirect. It does not move people back. If B now uses A's abbreviation, reactivating A is refused until one of them gets a different abbreviation.
- Ministry abbreviations only need to be unique among active ministries, so B can take over A's abbreviation.

## 3. Cabinet change

**Organizations** > **Cabinet change** lets you prepare every ministry change for a new cabinet and publish them all together, right away or at the swearing-in time. Nothing changes on the public site or for staff until it is published. One cabinet change is open at a time, and it is saved as you go, so you can come back to it later.

1. Under "Add a change", choose one of:
   - **Rename or change a ministry**: pick the ministry, then change its Name, Abbreviation or Minister.
   - **Add a new ministry**: Name, and optionally Abbreviation and Minister.
   - **Hand over a ministry**: pick the **Ministry to hand over**, then its **Successor** (a new ministry added in this change can be the successor). Choose "No successor (abolish it)" to close it with nothing moved. The "What moves to …" tick boxes are the same as in Section 2.

   Choose **Add this change**. The change appears under "Changes in this cabinet change", where **Remove** takes it out again.
2. Choose **Preview**. It runs the whole change without saving it and shows "What will change" (each ministry, now and after publishing), "What each hand-over moves", and "Ministries after this change". Any problem is listed under "Fix these before publishing", for example two active ministries ending up with the same abbreviation, a hand-over with no successor chosen, or a ministry handed over twice. When it says "No problems found", you can publish.
3. Under **Publish**, choose **Publish now…** and then **Yes, publish now**, or choose **Schedule…**, enter the date and time under "Publish at (BC time)" (usually the swearing-in time) and choose **Schedule**. A scheduled change shows "Publishes on {date} at {time} Pacific." and publishes by itself; nobody needs to be there. Until then you can still edit it, publish it now, or choose **Don't publish at that time (keep it as a draft)**. Editing a scheduled change takes it off its schedule: preview it and schedule it again.

Publishing makes every change at once: all of it or none of it. The public Ministries page updates within a few minutes, and subscribers, staff, Calendar activities and draft releases move shortly after.

If someone edits one of the ministries after you added a change to it, that change is marked "Changed by someone else since you added this." Check the ministry on **Organizations**, then **Keep this change** or **Remove** it. If a scheduled publish can't go through, the change goes back to a draft and the page shows "This change wasn't published" with the reason. Nothing is half-applied. To throw the whole draft away, use **Discard this cabinet change…** under "Start over".

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
   Compare the values, not the layout (the two print differently): both must be the same Pacific date and clock time. The date should be 2028-11-19. The clock time depends on the time-zone rules the host knows: 22:59 under ordinary winter time (UTC-8), 23:59 if the host's tzdata has British Columbia on permanent daylight time (UTC-7); on 2026-10-27 the developer's machine and its Postgres both gave 23:59. Why it matters: the database decides each release's term from its Pacific publish day and the app decides what the archive shows, so if the two disagree about Pacific time, a release published near midnight on a term's start date could be listed under the wrong term. If they differ, update the time-zone data (tzdata) on the older host before the election.
3. **Stuck moves.** If a hand-over's subscribers, Calendar activities or drafts have not moved after a few minutes, look for dead-lettered `org.succeeded` events (the Calendar dead-letters screen shows them). The moves are safe to run again.

Decisions behind all of this are recorded in `docs/parity/changes-from-legacy.md` (C11 and the "new government" rows) and `docs/parity/open-questions.md` (Q-NG1 to Q-NG7).
