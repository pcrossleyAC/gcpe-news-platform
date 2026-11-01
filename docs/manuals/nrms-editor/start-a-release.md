---
id: editor-start-a-release
title: Start a release
manual: nrms-editor
order: 20
routes: [/releases/new]
screens: [release]
topics: []
---
**Who this is for:** Release editors (NRMS.Editor).

## Create the release

1. In **Releases**, choose **New release**.
2. Choose the **Type**: **Release**, **Story**, **Factsheet** or **Advisory**.
3. Choose the **Page title** (required), such as **News Release** or **Backgrounder**. Choosing one also sets the usual **Layout** and **Page image** for it; you can change them.
4. Choose the **Layout**: **Formal** documents have an **Organizations** line, **Informal** ones a **Byline**.
5. Choose a **Page image**, or **(none)**. Advisories have none.
6. Enter the **Headline**.
7. If the release is for a Calendar activity, enter its number in **Calendar activity ID**. See below.
8. Enter the **Location**, such as VICTORIA.
9. Tick the **Ministries**. If you tick more than one, choose the **Lead ministry (needed before approving)**. An advisory doesn't need one.
10. Tick the **Sectors**, **Themes** and **Tags** that fit. Advisories have none.
11. Tick any **Media distribution lists** the release should go to. For an advisory the heading reads **Media distribution lists (needed before publishing)**: you can create it without one.
12. Choose **Create release**.

The release opens, ready to write. It is a **Draft** in the **Drafts** folder. Nobody is emailed and nothing is public.

If something is missing, a box headed "Fix these to create" lists it, such as "Choose a page title." or "Enter a headline.". Each line links to its field.

If the **Page title** list is empty, the page says "No page titles are set up yet. An administrator adds them under Release page titles." Ask a Core administrator.

## Which type to choose

| Type | Ministries | Sectors, themes, tags | Media lists | News On Demand subscribers | Can be unpublished |
|---|---|---|---|---|---|
| **Release** | At least one | At least one sector | Allowed | Emailed unless you untick it | Yes |
| **Story** | At least one | At least one sector | No | Not emailed unless you tick it | Yes |
| **Factsheet** | At least one | At least one sector | Allowed | Not emailed unless you tick it | Yes |
| **Advisory** | Optional | None | At least one | Never | No: once sent, it stays sent |

## Start from a Calendar activity

If you have Calendar access, a release can be linked to a Calendar activity.

- On **Forecast**, choose **Start a release** under the activity. **New release** opens with the activity filled in.
- Or type the number in **Calendar activity ID**. The activity's title, ministry and start appear under the field, and its "Translations required", if any.
- Choose **Fill in from activity 3** (the button names the number) to copy its start (as the planned publish date), its city (as the location), its lead and shared ministries, sectors, themes and tags. Check them before you create the release. The planned publish date shows as a line, such as "Planned publish date: Jun 11, 2031 10:00 AM, from the activity. You can change it in Publish settings once the release is created."

Nothing is filled in for an activity that has ended, or whose category doesn't start with "Approved"; the page says which. Other things you may see under the field:

| Message | What it means |
|---|---|
| "Calendar activity 3: its details aren't shown to you." | It is confidential, or your Calendar access doesn't let you see it. |
| "Calendar activity 3 has been deleted." | It can't be linked. |
| "No Calendar activity has ID 3." | Check the number. |
| "Legacy activity 3, not migrated" | A release brought over from the old system names an activity that didn't come across. It keeps that number until you change it. |

You can link or change the activity later in **Publish settings** on the release, as **Calendar activity ID**. Once a release is linked, the activity shows its status in the Calendar within a minute of each change.

## If you leave before creating it

If you have filled in anything and not chosen **Create release**, the Hub asks before you go to another screen: "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard it. What was filled in for you from a Calendar activity doesn't count. Closing or reloading the tab gets your browser's own question.
