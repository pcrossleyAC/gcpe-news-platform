---
id: editor-find-and-change-subscribers
title: Find and change subscribers
manual: nod-editor
order: 10
routes: [/subscribers]
screens: [subscribers]
topics: []
---
**Who this is for:** Subscribers editors (NoD.Editor).

**Find subscribers** lists everyone who has signed up or been added, 50 to a page, in address order. From a subscriber's record you change their lists, their address and whether they get email.

## Find someone

1. Type part of their address in **Email contains**.
2. To narrow the list, choose a **Status**.
3. Choose **Search**.
4. Choose an address to open that subscriber's record. **Back to results** on the record returns you to the same results.

The **Status** column shows one of these:

| Status | What it means |
|---|---|
| **Active** | They get the email they chose. |
| **Disabled** | They get nothing. Staff deactivated them, or their email kept bouncing. Their lists are kept. |
| **Unsubscribed or deleted** | They get nothing. Only they can subscribe again. |
| **Pending** | Never confirmed. You shouldn't see it: people who sign up on the public site get a record only once they confirm. |

"(needs attention)" after a status means a media list member has a problem to fix on **Media lists**.

The **Timing** column shows **None (media lists only)** for someone who is here only for media lists.

## Read a subscriber's record

The record shows **Status**, **Source**, **Registered** and, once they have left, **Ended**.

- **Disabled — after repeated bounces** means bounces disabled them. **Disabled — by staff** means someone deactivated them.
- **Source** says how they came: **Signed up themselves**, **Added by staff**, **Media Hub contact** or **Added to a media list by staff**.
- **Media lists** names the media lists they are on. Change those on **Media lists**.
- **Bounced emails counted (last 15 days)** shows how close they are to being disabled. It appears once an email has bounced. See [Bounces](manual:editor-bounces).
- **History** opens a list of every change: **When**, **What**, **Who** and **Detail**. "Subscriber" means the person did it themselves. "Bounce processing" and "Media Hub sync" are automatic. "Admin API" means a system tool made the change, not a person using the Hub. Staff changes show the staff member's name. The most recent 500 entries are shown.

## Change their lists or timing

1. Open their record. **Preferences** shows for **Active** and **Disabled** subscribers.
2. Tick **As it happens**, **Daily digest**, or both.
3. Under **Lists**, tick **All news**, or tick the lists they want. Lists they have that are no longer offered show under **No longer offered**. They keep those unless you untick them.
4. Choose **Save preferences**. You see "Preferences saved."

The change applies to the next email. Nobody is emailed about it. Saving doesn't activate a **Disabled** subscriber; choose **Activate** for that.

## Change their email address

1. Open their record.
2. Enter the address in **New email** and again in **Confirm new email**.
3. Choose **Change email**. You see "Email address changed. No confirmation email was sent." and the new address shows at the top of the record.

What this does:

- No confirmation email is sent.
- Links in emails already sent to the old address stop working, such as the link to change preferences. The unsubscribe links in those emails still work.
- **History** shows "Email address changed by staff". It doesn't record either address.

If the new address once unsubscribed from a media list this person is on, the Hub asks "That address unsubscribed" and says when. Choose **Change anyway** only if they have asked to get media releases there again. It counts as adding them back to those lists.

For a Media Hub contact, the record says "This address is managed in Media Hub. Change it there." instead of offering **Change email**.

## Deactivate or activate someone

Deactivate when someone should get nothing for a while, but keep their lists.

1. Open their record.
2. Choose **Deactivate**. The Hub asks "Deactivate this subscriber?" and explains "They receive nothing until activated again. Their lists, including media lists, are kept."
3. Choose **Confirm deactivate**. Their status becomes **Disabled — by staff**.

To bring back a **Disabled** subscriber, choose **Activate**. It happens at once, without a question. You see "Activated. Their bounce count starts again." They get the lists and timing shown under **Preferences**.

## Delete someone

Delete when a person asks to stop all email, or when a record must be removed.

1. Open their record.
2. Choose **Delete**. The Hub asks "Delete this subscriber?" and explains "They stop receiving email and are removed from every media list. Only they can subscribe again."
3. Under **Why are you deleting them?**, choose one:
   - **They asked us to stop sending them email**: for a person who phoned, wrote or emailed to say stop. The Hub explains "This is kept as their unsubscribe. If anyone adds them to a media list later, the Hub asks first."
   - **Something else, such as a duplicate or test record**: for cleaning up records.

   If you choose neither, you see "Choose why you’re deleting them." and nothing is deleted.
4. Choose **Confirm delete**. The record shows "Unsubscribed or deleted on" and the date and time.

What this does:

- Their status becomes **Unsubscribed or deleted** at once. You can't undo it. **Add a subscriber** refuses their address while the record exists.
- They are taken off every media list.
- With **They asked us to stop sending them email**, it counts as their unsubscribe, as if they had unsubscribed themselves. **History** shows "Unsubscribed", with "asked staff" under **Detail**, and "Left a media list", both with your name, and they appear under **Left this list** on each media list they were on. If anyone later adds them to any media list, the Hub asks "This person unsubscribed" first. This is kept even after the retention purge removes the record. On **Recent unsubscribes** they show as "Unsubscribed".
- With **Something else**, deleting isn't an unsubscribe, so it doesn't by itself make the Hub ask when you add them to a media list later. **History** shows "Deleted by staff". See [Media lists](manual:editor-media-lists).
- The record, with their address and history, stays. When a Subscribers administrator has the retention purge on, it is removed for good 90 days after they ended.
- Nobody is emailed.

## Change several at once

1. Search for the subscribers.
2. Tick the box beside each one. The box in the heading row ticks the whole page.
3. Choose **Activate selected**, **Deactivate selected** or **Delete selected**. The button shows how many you ticked, such as **Delete selected (2)**.
4. Read the question. For **Delete selected**, also choose an answer under **Why are you deleting them?**, the same two choices as on a record. Your answer applies to every ticked person, so tick only people who share the same reason.
5. Choose **Confirm activate**, **Confirm deactivate** or **Confirm delete**.

**Delete selected** does to each person exactly what **Delete** does on their record, for the reason you chose. See **Delete someone** above. For example, choose **They asked us to stop sending them email** when several people wrote in to say stop, and each one is kept as an unsubscribe.

Only the ticked rows on the page you are looking at are changed. A message such as "1 changed. 1 skipped: already in that state." gives the result. A skipped row isn't an error:

| Skipped because | What it means |
|---|---|
| already in that state | They were already active, disabled or deleted. |
| not allowed from their status | For example, activating someone who unsubscribed. |
| no longer exist | The record was removed. |
| couldn't change – try again | Something went wrong for that row. Try it again. |

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "The two email addresses don't match." | Type the same address in both boxes. |
| "Another subscriber record already has that address." | Choose **Open that record** to see it. Two records can't share an address. |
| "This address is managed in Media Hub. Change it there." | Update the contact in Media Hub. The nightly Media Hub sync brings the change here. |
| "Choose As It Happens, Daily Digest, or both." | A subscriber with lists needs a timing. |
| "Choose at least one list, or all news." | Tick a list or **All news**. Only someone on a media list can have no lists here. |
| "This subscriber's status changed; reload." | Someone else changed them. Reload the page. |
| "Subscriber not found." | The record has been removed for good, or the address in your browser is wrong. |
