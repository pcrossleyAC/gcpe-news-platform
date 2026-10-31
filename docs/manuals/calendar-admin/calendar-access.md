---
id: calendar-admin-access
title: Calendar access
manual: calendar-admin
order: 10
routes: [/calendar-access]
screens: [admin/calendar-access]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin).

**Calendar access**, under **Administration** in the side menu, gives a person a Calendar role and the ministries they work for. Each person has one role or **No Calendar access**.

The table shows everyone with a Hub account: **Name**, **Email**, **Calendar role** and **Ministries**. Inactive people are hidden until you tick **Show inactive users, including those with no email**.

## What you can give

- The roles, lowest to highest, are **Read Only**, **Editor**, **Advanced**, **Administrator** and **System Administrator**.
- Administrators can give any role up to **Administrator**. Only system administrators can give **System Administrator**.
- You can give any ministry, not just your own.
- HQ organizations are marked "— HQ" in the ministry list. Their members see every ministry in the Calendar. Only HQ Administrators and system administrators are offered them.
- HQ Administrator isn't a separate role: give **Administrator** and tick an HQ ministry.

## Give or change someone's access

The person needs a Hub account first. Only a Core administrator can add one.

1. Type part of their name or email in **Find a user by name or email**.
2. Choose **Edit** on their row.
3. Choose their **Calendar role**.
4. Under **Ministries**, tick every ministry they work for. A role needs at least one ministry.
5. Choose **Save Calendar access**. You see "Saved Calendar access for" followed by their name.

Saving replaces the person's whole ministry list with what is ticked.

You can make the same change from the person's page on **Calendar** > **Users**: choose **Edit Calendar access for** followed by their name.

## Remove someone's access

1. Choose **Edit** on their row.
2. Choose **No Calendar access** in **Calendar role**.
3. Choose **Save Calendar access**.

Their activities keep them as comm contact. To hand those activities to someone else, use [Transfer activities](manual:calendar-transfer).

## What happens next

- The change reaches the Calendar within a minute.
- A person whose access was removed sees "You don't have Calendar access. Ask a Calendar administrator." on their next click in the Calendar. They stay signed in to the Hub.
- Release editors see Calendar activities on the **Forecast** only if they have Calendar access, and only the activities that access lets them see.
- Nobody is emailed.

## When Edit isn't offered

Some rows show a note instead of **Edit**.

| Note | What it means |
|---|---|
| "You can't change your own Calendar access." | Ask another administrator or a Core administrator. |
| "Only a System Administrator or a Core administrator can change this user's access." | The person is a system administrator and you are an Administrator. |
| "Only an HQ Administrator, a System Administrator or a Core administrator can change this user's access." | The person belongs to an HQ organization and you don't. |
| "Only a Core administrator can give Calendar access to an inactive user who has none." | The person's Hub account is inactive and has no Calendar role. Ask a Core administrator. |

If you have no ministry yourself, the Calendar shows "You aren't in any ministry yet, so there are no activities to show you. Ask another Calendar administrator or a Core administrator to add your ministry." You can't add it yourself.

## Can't do this?

| Message | What it means |
|---|---|
| "choose at least one ministry for a Calendar role" | Tick a ministry, or choose **No Calendar access**. |
| "Health is no longer active or doesn't exist. Untick it, then save again." | The named ministry was deactivated while you were editing. Untick it. A person who already had a deactivated ministry keeps it when you save. |
