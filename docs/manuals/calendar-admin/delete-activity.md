---
id: calendar-delete-activity
title: Delete an activity
manual: calendar-admin
order: 50
routes: []
screens: [calendar/activity]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin).

Only administrators see **Delete** on an activity. You can delete an activity your ministry leads. HQ Administrators can delete any activity. A ministry that is only shared on an activity can't delete it.

## Delete an activity

1. Open the activity from the list.
2. Choose **Delete**. The Hub asks, for example, "Delete HLTH-2?" and explains "It leaves the list for everyone but HQ Administrators, who can review the deletion. Any unsaved changes are discarded."
3. Choose **Delete**. You are back on the list and see "Deleted HLTH-2."

## What happens next

- The activity leaves the list, **Updates** and the Excel export for everyone except HQ Administrators, and leaves every PDF report. Unless you are an HQ Administrator, you can't open it again either.
- HQ Administrators see it struck through in the list, waiting for them to review the deletion. See [HQ review](manual:calendar-hq-review).
- It leaves the **Forecast** in **Releases**, and no release can be linked to it from then on.
- A deletion can't be undone. To bring an activity back, create it again.
- Nobody is emailed.

## When Delete isn't offered

- The activity is led by another ministry, or only shared with yours.
- It is between the daily change freeze's hours, and you aren't HQ. The page shows the freeze message.
- Someone else is editing it.
- It is already deleted.

## Can't do this?

| Message | What it means |
|---|---|
| "Someone else changed this activity — reload to see their changes" | Someone saved it after you opened it. Choose **Reload**, check it, then delete. |
| "This activity is deleted" | Someone deleted it first. |
| "This activity is no longer available." | It was deleted, or moved out of your ministries, after you opened it. |
