---
id: calendar-hq-review
title: HQ review
manual: calendar-admin
order: 60
routes: [/calendar]
screens: [calendar/list]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin) who belong to an HQ organization.

HQ reviews what the ministries enter. This page is for HQ Administrators: Administrators and system administrators whose ministries include an HQ organization. **Review** and **Corporate Queries** are shared with HQ advanced users. **Review selected**, deleted activities and the **Exec Look Ahead** are yours alone.

For the list's filters, saved queries, columns and reports, see [The activity list](manual:calendar-advanced-list).

## What you see

- Every ministry's activities, confidential ones included.
- Cells changed since the last review are shaded in the list. Screen readers hear "(changed, needs review)".
- Deleted activities. A deletion waiting for your review shows struck through in the list while the filter's **Status** is **Any status** or **Changed**. On **Updates**, its lines are marked "(deleted)".

## Review one activity

1. Open the activity from the list.
2. Choose **Review**. You are back on the list and see, for example, "Reviewed HLTH-1."

Review marks the activity **Reviewed** and clears its "changed" marks. If you have unsaved changes, save or cancel them first; the page says "Save or cancel your changes to review or clone."

## Review a deletion

A deleted activity opens read-only and says "This activity is deleted. HQ Administrators can review the deletion; nothing else can change it." Its only action is **Review**.

Reviewing it takes it off the list's default view. The activity stays deleted. A corporate query with **Deleted** ticked still finds it.

## Review several at once

1. In the list, tick the box beside each activity number, such as **Select HLTH-1**.
2. Choose **Review selected**. The button shows how many are ticked, up to 500 at a time.
3. You see, for example, "Reviewed 3 activities."

An activity someone changed after your list loaded is skipped, and named: "1 skipped because it changed since the list loaded: HLTH-2." Open it, check the change, and review it again.

If you see "Only 100 of 300 activities were reviewed before a later batch failed", tick the rest and choose **Review selected** again.

## Corporate Queries

A corporate query lists every ministry's upcoming activities by status. It replaces your filter while it runs.

1. Open **Saved views**.
2. Under **Corporate Queries**, choose **Show all** or **For the next** a number of days.
3. Under **With status of**, tick **New**, **Changed**, **Reviewed**, **Deleted**, **LA New** or **LA Changed**.
4. Choose **Run corporate query**. The list says "Showing a corporate query." with what it shows.
5. Choose **Back to the filter** to return to your own filter.

**Changed** also finds deletions waiting for review. **Deleted** finds every deletion, reviewed or not.

The **Look Ahead filter** above the list narrows it to **Look Ahead Only** or **Not for Look Ahead Only**. **Show All** turns it off.

## Exec Look Ahead

The **Exec Look Ahead** is a PDF report only HQ Administrators can make.

1. Set the list's filter to the dates and activities you want.
2. Open **Export and reports**.
3. Choose **Exec Look Ahead**. You see "Preparing your Exec Look Ahead report…" and then "The Exec Look Ahead report has downloaded."

Each activity shows its title, summary, significance, city and venue, and when it was last updated. With no **To** date the report covers one month and adds the Long Term Outlook. Deleted activities are never in it.

The report is marked "DRAFT ONLY - NOT FOR CIRCULATION". Share it only with people who may see every ministry's plans.
