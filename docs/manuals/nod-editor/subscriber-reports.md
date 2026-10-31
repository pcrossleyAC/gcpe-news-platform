---
id: editor-subscriber-reports
title: Reports
manual: nod-editor
order: 40
routes: [/subscribers/reports]
screens: [subscribers/reports]
topics: []
---
**Who this is for:** Subscribers editors (NoD.Editor).

**Reports** shows who receives what, who left, and what was sent. Dates and times are BC time.

| Report | What it shows |
|---|---|
| **Active subscribers by list** | How many active subscribers each list has now, split by timing. **Show members** lists the people on one list. |
| **Recent unsubscribes** | Everyone who unsubscribed, or was deleted by staff, in the last 90 days. |
| **Sends per release** | For each release or alert published in the dates you choose, the as-it-happens and media list emails. |
| **Daily digest runs** | Each 5:00 pm digest: how many subscribers and emails. |
| **Distribution sent and bounced** | Every email sent from any app, by day and sender. |

## Choose dates

**Sends per release**, **Daily digest runs** and **Distribution sent and bounced** cover the last 30 days at first.

1. Enter **From (BC date)** and **To (BC date)**. Up to 92 days at a time.
2. Choose **Show**.

## See who is on a list

1. Open **Active subscribers by list**.
2. Choose **Show members** on the list's row.
3. To narrow it, choose a **Timing**: **Any timing**, **As it happens** or **Daily digest**.

Choose an address to open that subscriber's record.

## Download a CSV

Each report has a download link for a CSV file that opens in Excel, such as **Download (CSV)** or **Download counts (CSV)**.

Two downloads contain email addresses. Only Subscribers editors and administrators can use them:

- **Download members (CSV)** on **Active subscribers by list**, after you choose **Show members**. It has the members for the timing you chose.
- **Download list with addresses (CSV)** on **Recent unsubscribes**.

Each address download is recorded with your name and the report, never the addresses. Download addresses only when your work needs them, keep the file only as long as you need it, and don't send it on.

## Read the numbers

- **Handed off, not bounced** counts emails handed to Distribution, the sending service, less bounces. It is not proof of delivery. An email still queued, or one Distribution failed to send, still counts.
- **Not sent** means not yet handed off, including a send still going out.
- **Items in window** on **Daily digest runs** is worked out when you open the report. A release withdrawn since the run no longer counts, so an older run's number can go down.
- **Distribution sent and bounced** won't match the other two reports. It counts by the day it sent, has its own **Failed** column, and counts every bounce. The other reports go by the day the release was published or the digest ran, and count only bounces matched to a news email.

**Recent unsubscribes**:

- includes people who unsubscribed in the old News On Demand, at the dates they left;
- doesn't list people disabled by bounces. Find them on **Find subscribers** with the **Disabled** status;
- doesn't list someone whose status changed because you removed them from their last media list.

## Can't do this?

| Message | What it means |
|---|---|
| "Choose a range of 92 days or fewer." | Shorten the dates. |
| "The start date must be on or before the end date." | Swap the dates. |
| "Enter real dates." | Check both dates. |
| "That list doesn't exist any more." | The list was removed. Go back to the report. |
| "Distribution is unavailable right now. Try again in a few minutes." | Only **Distribution sent and bounced** is affected. The other reports still work. |
| "Couldn't load the report. Try again." | Reload the page. |
