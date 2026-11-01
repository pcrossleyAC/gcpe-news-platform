---
id: organizations
title: Organizations
manual: core-admin
order: 30
routes: [/organizations]
screens: [admin/organizations]
topics: [new-government]
---
**Who this is for:** Core administrators (Core.Admin).

**Organizations** holds every ministry: its name, minister, media contacts and page links, and the settings that decide who sees it. Site editors also open this screen, but they can only edit a ministry's details. Adding, deactivating, handing over and the **HQ** and **Public** settings are yours alone.

The table shows each ministry's **Name**, **Abbreviation**, **Minister**, **Active**, **HQ** and **Public**. A ministry that isn't public has a "Not public" badge. Inactive ministries are hidden until you tick **Show inactive organizations**.

For a new cabinet, prepare all the ministry changes together on [Cabinet change](manual:cabinet-change) instead of one at a time here.

## Edit a ministry

1. Choose **Edit** on the ministry's row. The form opens above the table.
2. Change what you need:
   - **Ministry name (required)** and **Additional display name**, which shows in brackets under the ministry on the Media Contacts page.
   - **Abbreviation** and **Parent ministry**, straight after the names. Only you see these.
   - **Sort order**: a whole number that places the ministry in lists.
   - **Minister name** (with the title, such as "Honourable Jane Doe"), **Minister summary**, **Minister email** and **Minister photo URL**. Upload the photo under **Website** > **Files** first, choose **Copy public address** beside it, then paste the address. A preview appears once the address starts with https://. An address copied from the Hub itself shows "This address points at the Hub, which the public can't open. On Website → Files, use Copy public address and paste that instead." Visitors couldn't see that photo. It shows for every web address of the Hub's server, not just the one you are using.
   - **Minister biography**: shown on the minister's biography page, linked as Read Bio. **Clear the biography** removes that page. After you rename the minister, a note warns "The biography still describes the previous minister."
   - **Meet the Team links**, **Media contacts** (**Primary contact**, **Alternate contact**, **After-hours phone**) and **Ministry page links** (**Ministry website**, **Photos (Flickr) address**, **Videos (YouTube) address**, **Featured Topics**, **Featured Services**).
   - **Active**, last, before **Save**. Only you see it.
3. Choose **Save**. You see "Saved. The public ministry pages update within a few minutes."

The public page shows the alternate contact only when there is a primary contact.

### The abbreviation

Every release number contains the lead ministry's abbreviation, as in 2026HLTH0001. Use 2 to 10 capital letters or digits. No two active ministries may share one. A release can't be approved until its lead ministry has an abbreviation: release editors see "The lead ministry has no abbreviation yet. Ask an administrator to add one, then approve again." Changing it affects only releases approved from then on.

## Add a ministry

1. Choose **Add ministry**.
2. Enter the **Ministry name (required)**. Below it you see the public web address made from the name, such as "Web address: /site/ministries/health/". The web address can't be changed later, even if you rename the ministry.
3. Enter the **Abbreviation** if you have it.
4. Choose **Create ministry**. The edit form opens so you can fill in the minister and contacts.

## Decide who sees a ministry

Tick or untick the boxes on the ministry's row. Each change saves at once and shows "Saved".

- **Public** ticked: the ministry is on the public ministry list and the subscribe page. Unticking asks "Remove {ministry} from the public site?" Choose **Remove from public site** to confirm.
- **HQ** ticked: everyone in this organization sees every ministry in the Corporate Calendar and gets its HQ-only fields and actions. Ticking asks "Make {ministry} an HQ organization?" Choose **Make HQ** to confirm. Unticking takes that view away from every member at once.

## Deactivate a ministry, or hand it over to another

Use a hand-over when a ministry is replaced: merged, split or renamed into a new one. A plain rename needs no hand-over: change the name with **Edit**. The web address, subscribers and history stay.

1. Choose **Deactivate** on the ministry's row. A panel titled "Deactivate {ministry}" opens.
2. In **Has a successor?**, choose the ministry that takes over its work. For a split, choose **Add another successor** and pick the next one. Staff, Calendar activities and draft releases go to the first successor.
3. Under "What moves to {successor}", untick anything that should stay behind. Each box shows how many it moves:
   - "Send {ministry}'s web pages to {successor}" is always on.
   - "Move {n} subscribers to {successors}." Subscribers are added to every successor.
   - "Move {n} staff from {ministry} to {successor}."
   - "Move {n} upcoming Calendar activities and {n} comm contacts to {successor}."
   - "Move {n} draft releases to {successor}." Approved and scheduled releases don't move. They are listed with links so you can change their lead ministry yourself.
   - "Let {successor} use the abbreviation {abbreviation}." This appears when the successor has no abbreviation. If it has one, tick "Replace {successor}'s abbreviation … with …" first.
4. Choose **Deactivate and hand over**. You see "{ministry} is deactivated. Its pages now send visitors to {successor}. Moves to other services finish shortly."

While a count loads it says "counting…". "count unavailable" means it couldn't be loaded; you can still go ahead.

To deactivate with nothing moved, leave **Has a successor?** at **No successor** and choose **Deactivate**. The panel warns that the ministry disappears from the public site, its subscribers stop receiving news, and they are not moved anywhere. Unticking **Active** in the edit form does the same.

### Set a successor later

For a ministry that is already inactive, tick **Show inactive organizations** and choose **Set successor…** on its row. The panel works the same way. Choose **Set successor** to finish.

## Reactivate a ministry

1. Tick **Show inactive organizations**.
2. Choose **Reactivate** on its row. You see "{ministry} is active again."

Reactivating stops its pages sending visitors to the successor. It does not move anyone back. It also doesn't change **Public**: if you see "It isn't public: tick Public to list it on the public site.", tick **Public** when it should be listed.

## What happens next

- Saved details reach the public Ministries page and each ministry's own page within a few minutes.
- After a hand-over, the old ministry's public web addresses send visitors to the successor. If the successor is later handed over too, the old addresses go straight to the newest ministry.
- Subscribers, staff, Calendar activities and drafts move in the background shortly after. If they haven't moved after a few minutes, tell the support team.
- A deactivated ministry can't be added to anyone's Calendar access. People who already have it keep it.

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "No changes to save." | Nothing in the form changed. |
| "That abbreviation is already used by {ministry}." | Another active ministry has it. Choose another, or change that ministry's first. |
| "Use 2 to 10 capital letters or digits, e.g. HLTH." | The abbreviation has the wrong form. |
| "A ministry with this name already exists ({web name})." | Use a different name, or edit the existing ministry. |
| "{ministry} already exists but is inactive. Use Reactivate on its row." | Reactivate it instead of adding it again. |
| "Use at least one letter or number in the name." | The name has no letters or digits to make a web address from. |
| "{third ministry} already uses the abbreviation {abbreviation}. Untick …" | During a hand-over, a third ministry holds the old abbreviation. Untick "Let {successor} use the abbreviation" or change that ministry's abbreviation first. |
| "{ministry} can't be reactivated while {successor} uses its abbreviation …" | The successor took the abbreviation. Give one of them a different abbreviation first. |
| "Choose an active ministry as successor." | Pick a successor before choosing **Set successor**. Inactive ministries can't be successors. |
| "{successor} already leads back to {ministry}; that would loop." | That successor was itself handed over to this ministry. Choose a different successor. |
