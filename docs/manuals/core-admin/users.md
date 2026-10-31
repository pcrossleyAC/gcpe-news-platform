---
id: users
title: Users
manual: core-admin
order: 10
routes: [/users]
screens: [admin/users]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Users** decides who can sign in to the Hub and what each person can do there. Only Core administrators see it.

The table lists every staff account with its **Name**, **Email**, **Sign-in** (**Password** or **Microsoft**), **Roles** and **Status**. A person with Calendar access also shows a line such as "Calendar: Editor (HLTH)"; you change that on [Calendar access](manual:calendar-access).

## Find someone

1. Type part of a name or email address in **Filter users**. You can also type a role as it appears in the table, such as "NRMS Site editor" or "Core Admin", or just a word of it, such as Editor.
2. The table narrows as you type, and the count shows "Showing 3 of 24 users". Type **active** or **inactive** to list people by status.

## Add a user

Add the person before they first sign in. Without an account, sign-in tells them "Your account hasn't been set up. Contact an administrator."

1. Under **Add a user**, enter their **Email**. For Microsoft sign-in, use their Microsoft sign-in name, which is usually their government email address.
2. Enter their **Display name**.
3. Under **Roles**, tick each role they need. Each box shows the role's name, as it appears in the table, and what it allows.
4. To let them sign in with a password, tick **Set a password now** and enter a **Password (at least 12 characters)**. Leave it unticked for people who sign in with Microsoft.
5. Choose **Add user**. The person appears in the table.

Nobody is emailed. Tell the person their account is ready.

### What each role allows

Each role has the same name in the table and beside its box.

| Badge | What it allows |
|---|---|
| **Core Admin** | Manage staff users, Project Blue Bridge, and the error log. It also opens every screen under **Administration**. |
| **NRMS Editor** | Create, edit, and publish news releases. |
| **NRMS Site editor** | Edit the public website's carousel, pins, Live Feed, links, and files. |
| **NRMS Viewer** | View news releases and the website, with no editing. |
| **NoD Viewer** | Search News on Demand subscribers and see their history, read-only. |
| **NoD Editor** | Add, edit, deactivate and delete News on Demand subscribers. |
| **NoD Admin** | Everything a NoD Editor can do, plus News on Demand operations and list categories. |
| **Distribution Send** | Send media distribution emails. |

Calendar roles are not on this screen. Give them on [Calendar access](manual:calendar-access).

## Change someone's account

1. Find the person and choose **Edit** on their row. Their settings open under the row.
2. Make one change, then choose the button beside it. Each button saves only its own part:
   - To rename them, change the display name and choose **Save name**. Until you do, "Name not saved yet." shows beside it.
   - To change what they can do, tick or untick roles and choose **Save roles**. Until you do, "Roles not saved yet." shows beside it. Saving replaces all their roles with the ticked ones.
   - Under **Account**, each action takes effect on its own: **Active**, **Unlink Microsoft sign-in**, and **Set password**. To set a new password, type it and choose **Set password**. You see "Password updated." This only appears for people who sign in with a password.
3. Choose **Close** on their row when you are done. Anything you typed but did not save stays there until you leave the page.

## Deactivate or reactivate someone

1. Choose **Edit** on their row.
2. Switch **Active** off. The Hub asks "Deactivate {name}?" and explains "They can't sign in until reactivated."
3. Choose **Deactivate**. You see "Saved" beside the switch.

To bring them back, switch **Active** on. It saves straight away, with no question.

## Link a person who has no email

People brought in from the old Calendar without an email show "No email" and "Inactive until linked to an email." They can't sign in.

1. Choose **Edit** on their row.
2. Enter their address in **Email for {name}**.
3. Choose **Link and activate**. Their email is set and they become active. If they sign in with a password, set one for them as well.

## Unlink Microsoft sign-in

After a person's first Microsoft sign-in, their **Sign-in** shows **Microsoft** and their password stops working. Unlink them when their Microsoft account was replaced, or when sign-in tells them "Your account needs an administrator to check it."

1. Choose **Edit** on their row. It shows "Sign-in: Microsoft (Entra)".
2. Choose **Unlink Microsoft sign-in**, then **Unlink** to confirm.
3. Ask them to sign in with Microsoft again. Their next Microsoft sign-in links them again by their email address.

Until they do, they are back on password sign-in, and any password they had before works again.

## What happens next

- Role changes and deactivation reach the person within 10 minutes. They take effect at once if the person reloads the Hub or comes back to its tab.
- A deactivated person is signed out at that point and can't sign in again.
- No change on this screen sends an email.

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question. A person's changes count even after you choose **Close** on their row: the Hub keeps them until you save them or leave.

## Can't do this?

| Message | What it means |
|---|---|
| "a user with that email already exists" | Someone already has that address. Filter the table to find them. |
| "use at least 12 characters" | The password is too short. |
| "you can't remove your own admin access" | You tried to take Core Admin off yourself, or to deactivate yourself. Ask another Core administrator. |
| "this user signs in with Microsoft; unlink them first" | Passwords can't be set for Microsoft sign-in. Unlink them first if they really need a password. |
| "set an email before activating this user" | The person has no email. Use **Link and activate**. |
| "this user already has an email" | The person was linked already. Reload the page. |
