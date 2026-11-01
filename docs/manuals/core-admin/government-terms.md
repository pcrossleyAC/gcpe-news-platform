---
id: government-terms
title: Government terms
manual: core-admin
order: 40
routes: [/government-terms]
screens: [admin/government-terms]
topics: [new-government]
---
**Who this is for:** Core administrators (Core.Admin).

**Government terms** sets the dates of each government term. The public archive groups releases by term. You enter only a start date: a term runs until the day before the next one starts, so terms never overlap and no end date is typed.

The table "Government terms, newest first" shows each term's **Term**, **Dates**, **Status** and how many **Releases** it holds. **Status** is Current, Past, Scheduled or Undated.

## Start a new government term

Do this as soon as the swearing-in date is announced. You can enter it weeks ahead.

1. Choose **Start new government term**.
2. Enter the **Start date (required)**: the first day of the new government, normally the swearing-in date.
3. Leave **Name (optional)** empty unless you want one. The public archive always shows the term's dates, with the name beside them if there is one.
4. Choose **Continue**. The Hub asks you to confirm, for example "Start a new government term on November 20, 2028? The current term will end November 19, 2028. Releases published from that day are listed under the new term."
5. Check the dates: the start date decides where every release is listed in the archive.
6. Choose **Confirm**, or **Go back** to change the date.

You see "Saved. The archive switches to the new term on {date}." If the date is today or earlier, you see "Saved. The new term is now the current term."

## Fix a term's dates or name

1. Choose **Edit** on the term's row.
2. Change the **Name**, the **Start date**, or the **Old archive web address**. The address is optional and must start with https://.
3. Choose **Save**.
4. If the term has already started and you changed its start date, the Hub asks first, because releases move between terms: "Change the start date to {date}? Releases published from that day will be listed under this term, and the term before it will end the day before." Choose **Confirm**.

You see "Saved." The archive pages and the current-term link rebuild by themselves.

## Delete a scheduled term

**Delete** appears only on a term that hasn't started and has no releases.

1. Choose **Delete** on its row. The Hub asks "Delete the term starting {date}? Nothing is listed under it yet, and the current term stays as it is."
2. Choose **Confirm**. You see "The term starting {date} is deleted."

## See who changed a term

Each start, date change, name change, old archive address change and deletion is listed in **Website** > **Website log**, with who made it and when. Choose **Government terms** in **Filter by area**. For example: "Moved the start of the government term starting November 20, 2028 to November 21, 2028". Everyone who can open **Website** sees these lines; term dates are public anyway.

## What happens next

- Each release is listed under the term that covers the day it was published, in BC time. A release published at 11:59 p.m. the day before the start date stays in the old term. One published at 12:00 a.m. on the start date is in the new term.
- At midnight Pacific on the start date, the public archive gets a page for the new term, and its current-term link points there. This happens even if nothing is published that day.
- Until the first release, the new term's page says "Nothing has been published in this term yet."
- An undated term never counts as current and is left out of the public archive. Give it a start date with **Edit**.

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "Another term already starts on that date." | Choose a different start date. |
| "Must be after {date} and before {date}." | A term's start date can't move past its neighbours. Choose a date between the two shown. |
| "A term that has started can't be moved to a date after today." | Start a new term instead. |
| "Only a term that hasn't started can be deleted." | Started terms stay. Fix their dates with **Edit**. |
| "A term with releases can't be deleted." | Releases are already listed under it. |
| "No changes to save." | Nothing in the form changed. |
