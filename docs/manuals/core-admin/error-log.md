---
id: error-log
title: Error log
manual: core-admin
order: 80
routes: [/error-log]
screens: [admin/errors]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Error log** shows the most recent errors the system recorded, newest first, so you can tell the support team what went wrong and when. It changes nothing.

## Check for errors

1. Open **Error log**. It shows up to 200 errors, the most recent first, or "No errors logged."
2. Choose **Refresh** to load newer entries.
3. Each row shows **When** it last happened, **How often**, a **Process ID** and the **Message**.

An error that happened more than once, with exactly the same message, is shown once. **How often** says "Once", or how many times and when it first happened, such as "212 times, first Oct 4, 2026 10:00 AM". So one problem that repeats every few minutes doesn't push the other errors out of view.

When you report a problem, copy the time and the whole message. The **Process ID** tells the support team which run of the system logged the last one.

## What to know

- Entries are kept when the system restarts.
- Values quoted in errors about stored records, such as an email address, are blanked out before the entry is kept.
- If the page says "Couldn't load the error log.", reload it. If that keeps happening, the system itself may be down: tell the support team.
- An update that one part of the system couldn't deliver to another for 24 hours is logged here once, and listed on [Undelivered updates](manual:undelivered-updates), where you can send it again.
