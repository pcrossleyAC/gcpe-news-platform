---
id: site-editor-organizations
title: Organizations
manual: nrms-site-editor
order: 150
routes: [/organizations]
screens: [admin/organizations]
topics: [new-government]
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Organizations** holds each ministry's public details: its name, minister, biography, media contacts and page links. They appear on the public Ministries page and on each ministry's own page.

The table shows each ministry's **Name**, **Abbreviation**, **Minister** and **Active**. A ministry left off the public site has a "Not public" badge. If any ministries are inactive, tick **Show inactive organizations** to list them too.

Adding, deactivating and handing over a ministry, its abbreviation and whether it is public are set by Core administrators.

## Edit a ministry

1. Choose **Edit** on the ministry's row. The form opens above the table.
2. Change what you need:
   - **Ministry name (required)**, and **Additional display name**, which shows in brackets under the ministry on the Media Contacts page, such as (Child Care).
   - **Sort order**: a whole number that places the ministry in lists.
   - **Minister name**, with the title, such as "Honourable Jane Doe" or "Premier Jane Doe". If you leave it empty, the ministry shows no minister.
   - **Minister summary** and **Minister email**.
   - **Minister photo URL**. Upload the photo on [Files](manual:website-files) first, then paste its full address here. A preview appears once the address starts with https://.
   - **Minister biography**: shown on the minister's biography page, linked as Read Bio from the ministry page. **Clear the biography** empties it, and the biography page goes when you save.
   - **Meet the Team links**: shown as Meet the Team on the ministry page.
   - Under **Media contacts**: **Primary contact** and **Alternate contact** (each with **Name**, **Phone**, **Cell** and **Email**), and **After-hours phone**. **Phone** shows as Direct on the ministry page.
   - Under **Ministry page links**: **Ministry website**, **Photos (Flickr) address**, **Videos (YouTube) address**, **Featured Topics** and **Featured Services**.
3. Choose **Save**. You see "Saved. The public Ministries page updates when the site next rebuilds."

**Cancel** closes the form without saving.

The public page shows the alternate contact only when there is a primary contact. The form warns "The public page shows the alternate only with a primary contact."

After you rename the minister, a note warns "The biography still describes the previous minister." Update or clear the biography too.

When a new government takes office, you update every minister's name, photo and biography. [When a new government takes office](topic:new-government) gives the order.

## What happens next

- Saved details reach the public site when it next rebuilds.
- Nobody is emailed.
- Changing a minister here doesn't change their contact record in Media Hub. Update that by hand.

## Can't do this?

| Message | What it means |
|---|---|
| "No changes to save." | Nothing in the form changed. |
| "Enter a ministry name." | **Ministry name (required)** is empty. |
| "Enter a whole number." | **Sort order** must be a whole number, such as 10. |
| "Enter the full address, starting with https://, to see a preview." | The photo address is incomplete. |
| "This address didn't load an image. Check that it's the right URL." | The photo address doesn't lead to an image. Check it on **Files**. |
