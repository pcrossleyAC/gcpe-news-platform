---
id: calendar-lookups
title: Calendar lookups
manual: calendar-admin
order: 40
routes: [/calendar/lookups]
screens: [calendar/lookups]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin).

**Calendar** > **Lookups** holds the choices offered on activities, such as categories, cities and HQ tags. Choose a lookup to see its rows. Rows are never deleted: you stop offering a row by making it inactive.

## Who can change which lookup

| Lookup | Extra boxes | Who can change it |
|---|---|---|
| **Event planners** | **Phone**, **Job title** | Every administrator |
| **HQ initiatives** | **Short name** | Every administrator |
| **HQ tags** | none | Every administrator |
| **Digital (videographers)** | **Job title** | Every administrator |
| **Categories**, **Cities**, **Comm materials**, **NR distributions**, **NR origins**, **Premier requested** | none | System administrators |
| **Government representatives** | **Description** | System administrators |

For Administrators, the system administrators' lookups are marked "(read only)" and say, for example, "Only a System Administrator can change categories."

Changes show on activities the next time someone opens one.

## Add a row

1. Open the lookup.
2. Under **Add**, such as **Add an HQ tag**, type the **Name** and any extra boxes.
3. Choose **Add**. You see "Added" and the name.

A new row goes to the end of the list.

Editors also add HQ tags by typing a new one in an activity's **HQ Tags**. It then appears here too.

## Change or stop offering a row

1. Choose **Edit** followed by the row's name.
2. Change the name or the extra boxes.
3. To stop offering it, untick **Active**. To offer it again, tick it.
4. Choose **Save**. You see "Saved" and the name.

An inactive row shows **Inactive** under **Status**. Activities that already have it keep it. Nobody can choose it for another activity.

Renaming a row renames it on every activity that has it.

## Change the order

Choose **Move** followed by the row's name and **up** or **down**. You see, for example, "Moved Housing up." Activities offer the rows in this order.

## Can't do this?

| Message | What it means |
|---|---|
| "an active row with that name already exists" | Two active rows can't share a name, whatever the capitals. Use the existing row, or make it inactive first. The same applies when you make an inactive row active again. |
| "enter a name" | The name is empty. |
| "the list changed since you loaded it: reload and try again" | Someone else added a row while you were moving one. Reload the page. |
