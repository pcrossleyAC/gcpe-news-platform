---
id: calendar-undelivered-events
title: Undelivered events
manual: calendar-admin
order: 70
routes: [/calendar/dead-letters]
screens: [calendar/dead-letters]
topics: []
---
**Who this is for:** Calendar system administrators (Calendar.SysAdmin).

**Calendar** > **Undelivered events** lists activity changes the Calendar couldn't send to another app for 24 hours. Only system administrators see this tab.

The Calendar sends every new, changed or deleted activity to **Releases**. Releases uses it for the **Forecast**, for linking a release to an activity, and for the activity details a new release fills in. While a change is undelivered, Releases still shows that activity as it was before.

"Nothing is waiting: every event was delivered." means all is well.

## What the table shows

The newest are first. "Only the 200 most recent are listed." means there are more.

| Column | What it shows |
|---|---|
| **Event** | What happened: "New activity", "Activity changed" or "Activity deleted". |
| **About** | Which activity, such as HLTH-12. An activity you can't see in the Calendar shows only its number, such as "Activity 12". |
| **To** | The app that didn't accept it, such as **Releases**. |
| **Attempts** | How many times the Calendar tried. |
| **Last error** | The last reason it failed, such as HTTP 503. |
| **Queued** | When the change was made, in BC time. |

The table never shows an activity's own text.

## Send one again

Before you retry, check that Releases is working, or ask your operations team.

1. Choose **Retry** on its row. The button shows "Retrying…" until the Calendar answers.
2. You see "Queued for delivery again." and the row leaves the table. The Calendar tries once more within the next minute.

If it fails again, it comes straight back to the table, without another 24 hours of tries. Reload the page after a minute to check. If it is back, Releases is still refusing it: have that fixed before you retry again.

Retrying an old change is safe. If a newer change to the same activity has already reached Releases, the newer one stays. If a newer change to the same activity is also waiting here, **Retry** on the older one says "A newer update replaced this one, so it isn't sent again.": retry the newest one instead.
