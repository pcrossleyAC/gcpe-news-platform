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

## Replaced updates

A row that says "Replaced by a newer update: not sent again" has no **Retry**. A later update about the same record, to the same part of the system, came after it. For example, a release was published and then unpublished while **Subscribers (News On Demand)** was refusing both. Sending the older one now would undo the newer one, or email subscribers about a release that was withdrawn, so the system never sends it again. Send the newer one, or dismiss both.

## Send one again

Before you retry, check that the part named under **Not accepted by** is working, or ask your operations team. The **Error log** usually shows why it refused.

1. Choose **Retry** on its row. The button shows "Retrying…" until the system answers.
2. You see "Queued for delivery again." and the row leaves the table. The system tries once more within the next minute.

If it fails again, it comes straight back to the table, without another 24 hours of tries. Choose **Refresh** after a minute to check.

Retrying sends the update as it was, now. A "Release published" update then emails that release's subscribers, however late. Check the release is still published, and still worth emailing, before you retry it.

## Send them all again

When one part has more than one waiting, a button such as **Retry all 3 from Releases** appears above the table. It asks first: how many it will send again, how many replaced updates it leaves out, and, for **Releases**, that published releases email their subscribers. Choose **Resend** to send them, oldest first, or **Cancel**.

## Dismiss an update

An update that doesn't need sending any more can be dismissed: for example because the change was made again by hand, or the receiving part was retired. A dismissed update is never sent.

- Choose **Dismiss** on its row. You see "Dismissed: it won't be sent." and the row leaves the table.
- **Dismiss all**, above the table, dismisses every update listed, from every part. It asks first.

The **Dismissed** table below lists the most recent dismissals, with when and who dismissed each.

## What is safe

- Retrying an update that was in fact received is harmless: the receiving part ignores a copy it already has.
- The system never resends a replaced update, on its own or with **Retry all**.
- What retrying can't undo is an email. A retried "Release published" emails subscribers when it is sent.

## What to know

- The Calendar's system administrators also see the Calendar's own updates on **Calendar** > **Undelivered events**. Retrying from either screen does the same thing.
- The system's health check, which the operations team monitors, reports "degraded" while any update from the last 7 days is waiting here. Replaced and dismissed updates don't count. Retrying or dismissing is what clears it.
