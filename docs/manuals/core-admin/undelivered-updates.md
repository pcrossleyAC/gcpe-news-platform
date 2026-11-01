---
id: undelivered-updates
title: Undelivered updates
manual: core-admin
order: 85
routes: [/undelivered-updates]
screens: [admin/undelivered]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Undelivered updates** lists the updates one part of the system sent to another that weren't accepted within 24 hours. For example, a published release that never reached **Subscribers (News On Demand)**, so no one was emailed, or a ministry change that never reached **Releases**. The system keeps trying each update for 24 hours before it lists it here.

"Nothing is waiting: every update was delivered." means all is well.

## What the table shows

The newest are first.

| Column | What it shows |
|---|---|
| **When** | When the update was sent. |
| **From** | The part of the system that sent it, such as **Releases**, **Core administration**, **Email sending**, **News service** or **Calendar**. |
| **Update** | What it was about, such as "Release published: Highway 11 traffic change" or "Organization deactivated: health". |
| **Not accepted by** | The part of the system that refused it, such as **Subscribers (News On Demand)** or **Public site**. |
| **Last error** | The last reason it failed, such as HTTP 503, shortened if it is long. |

The table never shows an update's full text. A Calendar activity shows only its number, such as "Activity 12".

If one part has more than 200 waiting, a line above the table says so, and only the 200 most recent from it are listed.

## Send one again

Before you retry, check that the part named under **Not accepted by** is working, or ask your operations team. The **Error log** usually shows why it refused.

1. Choose **Retry** on its row. The button shows "Retrying…" until the system answers.
2. You see "Queued for delivery again." and the row leaves the table. The system tries once more within the next minute.

If it fails again, it comes straight back to the table, without another 24 hours of tries. Choose **Refresh** after a minute to check.

## Send them all again

When one part has more than one waiting, a button such as **Retry all 3 from Releases** appears above the table. It does the same as **Retry** for every update from that part at once. You see how many were queued.

Retrying is safe. If a newer change to the same record has already arrived, the newer one stays.

## What to know

- The Calendar's system administrators also see the Calendar's own updates on **Calendar** > **Undelivered events**. Retrying from either screen does the same thing.
- The system's health check, which the operations team monitors, reports "degraded" while any update from the last 7 days is waiting here.
