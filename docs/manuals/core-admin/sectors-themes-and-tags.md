---
id: sectors-themes-and-tags
title: Sectors, themes and tags
manual: core-admin
order: 50
routes: [/categories]
screens: [admin/categories]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Sectors, themes and tags** keeps the three lists that release editors use to file releases. The public site has a page for each one, and subscribers can follow them.

Choose **Sectors**, **Themes** or **Tags** under **Show** to see one list. Each row has a **Key**, a **Name**, an **Order** and an **Active** box. The key is part of the public web address and never changes.

## Rename, reorder or retire entries

You can change several rows, even across the three lists, and save them together.

1. Change the **Name** or **Order** on any row. Order is a whole number; lower numbers come first.
2. To retire an entry, untick **Active**. To bring one back, tick it again.
3. Changed rows show "Unsaved", and a note below the table counts them, such as "2 rows have unsaved changes".
4. Choose **Save changes**. If you retired anything, the Hub asks "Retire {name}?" and explains that it leaves the public site's lists, the subscribe page and the release editor's choices. Choose **Retire**.

You see "Saved {n} changes."

## Add a sector, theme or tag

1. Choose the list under **Show**.
2. Under **Add a sector** (or theme, or tag), enter the **Name**. The **Key** fills in from the name; you can change it. Use lowercase letters, numbers and hyphens.
3. Choose **Add sector** (or **Add theme**, **Add tag**). You see "Added {name} ({key})."

The new entry goes to the end of the list and is active. Adding never changes an entry that already exists. If the key is taken, you see a message beside the form and nothing is added.

## What happens next

- Changes reach the public site, the subscribe page and the release editor within a minute.
- A retired entry leaves those lists. Releases already filed under it keep it.
- Nobody is emailed.

## Can't do this?

| Message | What it means |
|---|---|
| "Name is required." | Enter a name. |
| "Name is too long (at most 100 characters)." | Shorten the name. |
| "Order must be a whole number." | Enter a number such as 3. |
| "Keys use lowercase letters, numbers and hyphens (at most 100)." | Fix the key. |
| "A sector with the key health already exists: Health." (or "A theme…", "A tag…") | The key is taken, and the message names the entry that has it. Choose another key. To bring a retired entry back, tick **Active** on its row. |
| "{n} rows couldn't be saved — see the message on those rows." | The other rows were saved. Fix the rows with a message and save again. |
| "No changes to save." | Nothing was changed. |
