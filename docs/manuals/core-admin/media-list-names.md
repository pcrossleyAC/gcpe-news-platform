---
id: media-list-names
title: Media list names
manual: core-admin
order: 70
routes: [/media-list-names]
screens: [admin/media-lists]
topics: []
---
**Who this is for:** Core administrators (Core.Admin).

**Media list names** decides which media lists exist, what they are called and the order they appear in. Release editors pick these lists to send a release to reporters. The reporters on each list are managed by News On Demand staff under **Subscribers** > **Media lists**. If you also have a News on Demand role, the screen's "Subscribers, Media lists" is a link there.

Each row has a **Key**, a **Name**, an **Order** and an **Active** box.

## Rename or reorder a list

1. Change the **Name** or **Order** on its row.
2. Choose **Save** on that row. You see "{key} saved."

## Retire a list

1. Untick **Active** on its row.
2. Choose **Save**. The Hub asks "Retire {key}?" and explains "Releases can no longer be sent to it. Its members are kept, and ticking Active again brings it back."
3. Choose **Retire list**.

## Add a list

1. Under **Add a media list**, enter the **Key**: lowercase letters, numbers and hyphens. It can't be changed later.
2. Enter the **Name**.
3. Choose **Add media list**. You see "Media list added. It reaches News On Demand within a minute."

## What happens next

- Changes reach News On Demand's media lists within a minute.
- A retired list can't be put on a release. A release that already had it shows it ticked, greyed out and marked "(retired)"; nothing is sent to it.
- Nobody is emailed.

## Can't do this?

| Message | What it means |
|---|---|
| "A media list with that key already exists." | Choose another key. To bring back a retired list, tick **Active** on its row. |
| "Keys use lowercase letters, numbers and hyphens; both fields are required." | Fix the key, and fill in both fields. |
| "Name is required." | Enter a name. |
| "Order must be a whole number." | Enter a number such as 3. |
