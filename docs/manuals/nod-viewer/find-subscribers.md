---
id: nod-viewer-find-subscribers
title: Find a subscriber
manual: nod-viewer
order: 10
routes: [/subscribers]
screens: [subscribers]
topics: []
---
**Who this is for:** Subscribers viewers (NoD.Viewer).

## Find someone

1. Type part of their address in **Email contains**.
2. To narrow the list, choose a **Status**.
3. Choose **Search**.
4. Choose an address to open that subscriber's record.

Results show 50 to a page, in address order. **Back to results** on a record returns you to the same results.

The **Status** column shows one of these:

| Status | What it means |
|---|---|
| **Active** | They get the email they chose. |
| **Disabled** | They get nothing. Staff deactivated them, or their email kept bouncing. Their lists are kept. |
| **Unsubscribed or deleted** | They get nothing. Only they can subscribe again. |
| **Pending** | Never confirmed. You shouldn't see it: people who sign up on the public site get a record only once they confirm. |

"(needs attention)" after a status means a media list member has a problem. See [Media lists](manual:nod-viewer-media-lists).

## Read a subscriber's record

The record shows **Status**, **Source**, **Registered** and, once they have left, **Ended**.

- **Disabled — after repeated bounces** means their email kept coming back undelivered. **Disabled — by staff** means someone deactivated them.
- **Source** says how they came: **Signed up themselves**, **Added by staff**, **Media Hub contact** or **Added to a media list by staff**.
- **Media lists** names the media lists they are on.
- **Bounced emails counted (last 15 days)** appears once an email to them has bounced. When their last 10 emails within 15 days have all bounced because the address doesn't work, they are disabled. A media list member is flagged **Bouncing** instead, and is still sent email.
- **Preferences**, for **Active** and **Disabled** subscribers, shows their timing, and **All news** or the lists they chose. **None (media lists only)** means they are here only for media lists.
- A deleted or unsubscribed record says "Unsubscribed or deleted on" and the date and time.

## See their history

Choose **History** on their record. **Back to subscriber** returns you to it.

Each change shows **When**, **What**, **Who** and **Detail**. In **Who**:

- "Subscriber" means the person did it themselves;
- a staff member's name means that person did it in the Hub;
- "Bounce processing" and "Media Hub sync" are automatic;
- "Admin API" means a system tool made the change, not a person using the Hub.

If there are more than 500 changes, you see "Showing the most recent 500 entries."

## Can't do this?

| Message | What it means |
|---|---|
| "No subscribers match." | Nobody's address contains what you typed, with that status. Try fewer letters, or **All**. |
| "Subscriber not found." | The record has been removed for good, or the address in your browser is wrong. |
| "Couldn't load subscribers." or "Couldn't load this subscriber's history." | Reload the page. |
