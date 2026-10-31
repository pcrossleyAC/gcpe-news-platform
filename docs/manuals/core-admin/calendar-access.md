---
id: calendar-access
title: Calendar access
manual: core-admin
order: 20
routes: [/calendar-access]
screens: [admin/calendar-access]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Calendar access** gives staff a Calendar role and the ministries they work for. Calendar administrators and Calendar system administrators use this screen too, but with limits that don't apply to you.

The table shows each person's **Name**, **Email**, **Calendar role** and **Ministries**. Inactive people are hidden until you tick **Show inactive users, including those with no email**.

## The Calendar roles

From lowest to highest: **Read Only**, **Editor**, **Advanced**, **Administrator**, **System Administrator**. Each person has one role or **No Calendar access**. What each role can do in the Calendar is in the Calendar manuals.

Members of an HQ organization see every ministry in the Calendar. GCPE Headquarters, GCPE Media Relations and the Office of the Premier are usually HQ. You decide which organizations are HQ on [Organizations](manual:organizations).

## Give or change someone's Calendar access

The person needs a Hub account first. Add them on [Users](manual:users) if they have none.

1. Type part of their name or email in **Find a user by name or email**.
2. Choose **Edit** on their row.
3. Choose their **Calendar role**.
4. Under **Ministries**, tick every ministry they work for. HQ organizations are marked "— HQ". A role needs at least one ministry.
5. Choose **Save Calendar access**. You see "Saved Calendar access for {name}."

Saving replaces the person's whole ministry list with what is ticked.

## Remove someone's Calendar access

1. Choose **Edit** on their row.
2. Choose **No Calendar access** in **Calendar role**.
3. Choose **Save Calendar access**.

## What happens next

- The change reaches the Calendar within a minute.
- A person whose role was removed sees "You don't have Calendar access" on their next click in the Calendar. They are not signed out of the Hub.
- Nobody is emailed.

## Limits that apply to other administrators

You may change anyone, including yourself. Calendar administrators and Calendar system administrators can't, and the screen shows them a note instead of **Edit**:

- "You can't change your own Calendar access."
- "Only a System Administrator or a Core administrator can change this user's access."
- "Only an HQ Administrator, a System Administrator or a Core administrator can change this user's access."
- "Only a Core administrator can give Calendar access to an inactive user who has none."

When one of them sends a request like this to you, make the change yourself.

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "choose at least one ministry for a Calendar role" | Tick a ministry, or choose **No Calendar access**. |
| "Health is no longer active or doesn't exist. Untick it, then save again." | The named ministry was deactivated while you were editing. Untick it. A person who already had a deactivated ministry keeps it when you save. |
