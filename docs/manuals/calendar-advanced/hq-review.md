---
id: calendar-advanced-hq
title: HQ review and corporate queries
manual: calendar-advanced
order: 60
routes: []
screens: [calendar/list, calendar/activity]
topics: []
---
**Who this is for:** Calendar advanced users (Calendar.Advanced) who belong to an HQ organization.

HQ reviews what the ministries enter. If none of your ministries is an HQ organization, you don't see these tools.

## What HQ sees

- Every ministry's activities, including those marked **Confidential (not for Look Ahead)**.
- On an activity, each field changed since the last review says "Changed: needs review".
- The **Look Ahead** section on every activity. See [Activity fields](manual:calendar-advanced-fields).
- **Search for** in the list's **Filters** also searches the **Executive Summary**.

You don't see deleted activities. Reviewing deletions is for HQ Administrators.

## Review an activity

1. Open the activity.
2. Check what changed. **View changes** shows each change before and after.
3. Choose **Review**. You go back to where you opened it, and see, for example, "Reviewed HLTH-21."

Review marks the activity **Reviewed** and clears its "Changed: needs review" marks. It shows on **Updates** as "reviewed activity".

If you have unsaved changes, save or cancel them first: the page says "Save or cancel your changes to review or clone."

If you see "Someone else changed this activity — reload to see their changes", choose **Reload**, check the new change, then choose **Review** again.

You review one activity at a time. **Review selected**, which reviews many at once from the list, is for HQ Administrators.

## Run a corporate query

A corporate query lists every ministry's upcoming activities by status. It replaces your filter while it runs.

1. Open **Saved views**.
2. Under **Corporate Queries**, choose **Show all**, or **For the next** and a number of days. It starts at 8.
3. Under **With status of**, tick any of **New**, **Changed**, **Reviewed**, **Deleted**, **LA New** and **LA Changed**. **New** and **Changed** start ticked.
4. Choose **Run corporate query**. Above the list you see, for example, "Showing a corporate query. Every ministry's activities: next 8 days, New and Changed."
5. Choose **Back to the filter** to return to your own filter.

**Deleted** finds nothing for you, since you can't see deleted activities.

## The Confidential filter

The **Confidential filter** above the list (the old Calendar's Look Ahead filter) narrows the list, and the reports made from it:

- **Not confidential only** shows activities that aren't marked **Confidential (not for Look Ahead)**.
- **Confidential only** shows only those that are.
- **Show All** turns it off.

It works straight away, without **Apply filters**. While it is on, the line beside **Filters** names it. A saved query doesn't keep it.

## Clear LA Status

HQ editors can do this too. It clears **LA New** and **LA Changed**, so the next Look Ahead flags only what is new or changed since.

1. Choose **LA status** above the list.
2. In **Days ahead (Clear LA Status)**, enter a number of days. It starts at 8.
3. Choose **Clear LA Status**. The Hub asks, for example, "Clear the LA status of 3 activities?" and explains "Every activity you can see that starts up to 8 days ahead, past ones included, loses its LA New or LA Changed status. Each change is recorded in the activity's history."
4. Choose **Clear LA Status**. You see, for example, "Cleared the LA status of 3 activities."

With nothing to clear, you see, for example, "No activities up to 8 days ahead have an LA status to clear."

It doesn't show on **Updates**. Each activity's **View changes** says "cleared its LA status".

If you see "The LA status of 2 activities was cleared before a later batch failed. Run Clear LA Status again to finish.", choose **Clear LA Status** again.

## What isn't yours

The **Exec Look Ahead** report, **Review selected** and reviewing deletions are for HQ Administrators. Deleting an activity is for Calendar administrators.
