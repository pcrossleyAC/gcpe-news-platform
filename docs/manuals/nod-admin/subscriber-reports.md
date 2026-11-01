---
id: subscriber-reports
title: Reports
manual: nod-admin
order: 50
routes: [/subscribers/reports]
screens: [subscribers/reports]
topics: []
---
**Who this is for:** Subscribers administrators (NoD.Admin).

**Reports** shows who receives what, who left, and what was sent. Dates and times are BC time.

| Report | What it shows |
|---|---|
| **Active subscribers by list** | How many active subscribers each list has now, split by timing. **Show members** lists the people on one list. |
| **Recent unsubscribes** | Everyone who unsubscribed, or was deleted by staff, in the last 90 days. |
| **Sends per release** | For each release or alert published in the dates you choose, the as-it-happens and media list emails, and any corrected copies a release editor emailed again. |
| **Daily digest runs** | Each 5:00 pm digest: how many subscribers and emails. |
| **Distribution sent and bounced** | Every email sent from any app, by day and sender. |

## Choose dates

**Sends per release**, **Daily digest runs** and **Distribution sent and bounced** cover the last 30 days at first.

1. Enter **From (BC date)** and **To (BC date)**. Up to 92 days at a time.
2. Choose **Show**.

## Download a CSV

Each report has a **Download** link for a CSV file that opens in Excel.

These downloads contain email addresses:

- **Download members (CSV)** on **Active subscribers by list**, after you choose **Show members**.
- **Download list with addresses (CSV)** on **Recent unsubscribes**.

Each address download is recorded with your name and the report, never the addresses. Keep the file only as long as you need it. Subscribers viewers can't download addresses.

## Read the numbers

- **Handed off, not bounced** counts emails handed to Distribution, the sending service, less bounces. It is not proof of delivery. An email still queued, or one Distribution failed to send, still counts.
- **Not sent** means not yet handed off: a send still going out, held while News On Demand sending is paused, failed, or cancelled on **Operations**.
- **Items in window** on **Daily digest runs** is worked out when you open the report. A release withdrawn since the run no longer counts, so an older run's number can go down.
- **Distribution sent and bounced** won't match the other two reports. It counts by the day it sent, has its own **Failed** column, and counts every bounce. The other reports go by the day the release was published or the digest ran, and count only bounces matched to a news email.
- **Recent unsubscribes** doesn't list people disabled by bounces. Find them on **Find subscribers** with the **Disabled** status. It does include people who unsubscribed in the old News On Demand, at the dates they left.

## Can't do this?

| Message | What it means |
|---|---|
| "Choose a range of 92 days or fewer." | Shorten the dates. |
| "The start date must be on or before the end date." | Swap the dates. |
| "Enter real dates." | Check both dates. |
| "That list doesn't exist any more." | The list was removed. Go back to the report. |
| "Distribution is unavailable right now. Try again in a few minutes." | Only **Distribution sent and bounced** is affected. The other reports still work. |
