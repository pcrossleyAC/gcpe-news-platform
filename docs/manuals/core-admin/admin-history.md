---
id: admin-history
title: Admin history
manual: core-admin
order: 85
routes: [/admin-history]
screens: [admin/history]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Admin history** answers "who changed this, and when?" for the administration screens: **Users**, **Calendar access**, **Organizations**, **Sectors, themes and tags** and **Cabinet change**. It changes nothing. Only Core administrators see it.

Each change is listed with **When** (BC time), **Who** made it and **What** they did, newest first, such as "Gave Core Admin to Jo Lee" or "Renamed Ministry of X to Ministry of Y". Names are as they were at the time. Changes made by a Calendar administrator on **Calendar access** are listed under their own name. The break-glass administrator shows as "Administrator (break-glass)". A cabinet change that published on its own at its scheduled time shows as "Scheduled cabinet change".

## Find a change

1. Open **Admin history**. It shows the 50 most recent changes.
2. Narrow the list, using any of these:
   - **Who**: part of the name of the person who made the change.
   - **What**: **Users**, **Calendar access**, **Organizations**, **Sectors, themes and tags** or **Cabinet change**.
   - **From** and **To**: BC dates. Both days are included.
3. Choose **Show**. The count above the table says how many changes match.
4. Choose **Next** and **Previous** to page through them. **Clear filters** shows everything again.

To see one person's or one ministry's changes, choose **Edit** on their row on [Users](manual:users) or [Organizations](manual:organizations), then open **History**.

## What to know

- Changes are kept for good. Nothing on this screen can be edited or deleted.
- Only what changed is kept: a name or abbreviation before and after, the roles given or taken, which ministry details changed. Passwords never are: the history says only that a new password was set.
- Changes made before the Hub started keeping this history aren't listed.
- Changes on **Government terms** aren't listed here. They are in **Website** > **Website log**: choose **Government terms** in **Filter by area**. Site editors and everyone else who can open **Website** see those lines too; term dates are public anyway.
- Two entries aren't made on these screens. A person's first Microsoft sign-in, which links their account, is listed under their own name. Sending every ministry, user, sector, theme and tag to the other apps again is listed under whoever started it.

## Can't do this?

| Message | What it means |
|---|---|
| "From must be on or before To." | The dates are the wrong way round. Swap them, then choose **Show**. |
| "No changes match these filters." | Nothing matches. Try part of a name, or a wider date range. |
| "Couldn't load the admin history." | Reload the page. If that keeps happening, tell the support team. |
