---
id: nod-viewer-reports
title: Reports
manual: nod-viewer
order: 40
routes: [/subscribers/reports]
screens: [subscribers/reports]
topics: []
---
**Who this is for:** Subscribers viewers (NoD.Viewer).

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

To go back to the last 30 days, clear both dates and choose **Show**. You can type new dates while a report is still loading.

## See who is on a list

1. Open **Active subscribers by list**.
2. Choose **Show members** on the list's row. The members show below the counts.
3. To narrow it, choose a **Timing**: **Any timing**, **As it happens** or **Daily digest**.

Choose an address to open that subscriber's record.

## Download a CSV

Each report has a link to download it as a CSV file that opens in Excel, such as **Download (CSV)**, **Download counts (CSV)** or **Download daily counts (CSV)**.

You can't download email addresses. **Reports** says "CSV files with email addresses are for News On Demand editors and administrators." If your work needs a file of addresses, ask a Subscribers editor.

## Read the numbers

- **Handed off, not bounced** counts emails handed to Distribution, the sending service, less bounces. It is not proof of delivery. An email still queued, or one Distribution failed to send, still counts.
- **Not sent** means not yet handed off: a send still going out, held while News On Demand sending is paused, failed, or cancelled by a Subscribers administrator.
- Daily digest emails are counted in **Daily digest runs**, once for each subscriber, not in **Sends per release**.
- **Items in window** on **Daily digest runs** is worked out when you open the report. A release withdrawn since the run no longer counts, so an older run's number can go down.
- **Distribution sent and bounced** won't match the other two reports. It counts by the day it sent, has its own **Failed** column, and counts every bounce. The other reports go by the day the release was published or the digest ran, and count only bounces matched to a news email.

**Recent unsubscribes**:

- includes people who unsubscribed in the old News On Demand, at the dates they left;
- doesn't list people disabled by bounces. Find them on **Find subscribers** with the **Disabled** status;
- doesn't list someone whose status changed because staff removed them from their last media list.

## Can't do this?

| Message | What it means |
|---|---|
| "Choose a range of 92 days or fewer." | Shorten the dates. |
| "The start date must be on or before the end date." | Swap the dates. |
| "Enter real dates." | Check both dates. |
| "That list doesn't exist any more." | The list was removed. Go back to the report. |
| "Distribution is unavailable right now. Try again in a few minutes." | Only **Distribution sent and bounced** is affected. The other reports still work. |
| "Couldn't load the report. Try again." | Reload the page. |
