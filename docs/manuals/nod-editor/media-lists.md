---
id: editor-media-lists
title: Media lists
manual: nod-editor
order: 30
routes: [/subscribers/media-lists]
screens: [subscribers]
topics: []
---
**Who this is for:** Subscribers editors (NoD.Editor).

**Media lists** holds the reporters on each media list. Release editors pick these lists on a release, and every member gets the full-text media version.

The table shows each list's **Members**, how many **Need attention**, and its **Status**. A **Retired** list can't be put on a release, and nothing is sent to it, even from a release that already had it. Core administrators add, rename and retire lists.

Choose a list's name to open it. Each member shows their **Email**, their **Source** (**Media Hub**, **Added by hand** or **Subscriber**) and any problem under **Needs attention**.

## Add a reporter from Media Hub

1. Open the list.
2. Under **Add from Media Hub**, type a name, email or outlet in **Name, email or outlet**.
3. Choose **Search Media Hub**. Each contact shows their outlet and their addresses, such as "(workplace, preferred)".
4. Choose **Add** and the address you want. You see "Added to the list."

## Add an address by hand

Use this for people who aren't in Media Hub.

1. Open the list.
2. Under **Add an address by hand**, enter the **Email address**.
3. Choose **Add to list**. You see "Added to the list."

## What adding does

Nobody is emailed. The reporter gets the next release sent to this list. What else happens depends on the address:

| The address | What happens |
|---|---|
| Has no record | A new record is made for media email only. Its **Source** is "Media Hub contact", or "Added to a media list by staff" for an address added by hand. |
| Is **Active** | They keep their news release email as it was. |
| Is **Disabled** | See the next section. |
| Is **Unsubscribed or deleted** | They become **Active** for media email only. Their timing and news lists are taken off. If they unsubscribed themselves, the Hub may ask first; see below. |

### Adding a Disabled subscriber

Being added to a media list is not a request for news release email. So when the address is **Disabled**:

- They become **Active**, and get media email only.
- Their **As it happens** and **Daily digest** timing and their news lists are taken off. Media lists they were already on are kept.
- Their bounce count starts again.
- **History** shows "Added to a media list while Disabled. News release email stays off". **Detail** lists the timing and lists they had.
- You see "Added to the list. Their news release email stays off; open their record to turn it on." instead of "Added to the list."

If the person has also asked for news release email again:

1. Choose **open their record** in that message.
2. Tick **As it happens** or **Daily digest**, and their lists.
3. Choose **Save preferences**.

### If they unsubscribed

The Hub asks "This person unsubscribed" and says when, in these cases:

- They unsubscribed while they were on this list. Unsubscribing stops all their email, media lists included. The Hub asks even if they have signed up again since.
- They unsubscribed from all News On Demand email while they weren't on this list, and haven't signed up again since. Once they sign up again, it doesn't ask.
- Their old record was removed for good after they unsubscribed. The Hub asks even if they have signed up again since.

It doesn't ask when staff deleted them or removed them from the list, or once you have added them back to this list.

Choose **Add anyway** only if they have asked to get media releases again. Otherwise choose **Cancel**.

## Remove a reporter

1. Open the list.
2. Choose **Remove** and their address on their row. The Hub asks "Remove [their address] from this list?" and explains "If this is their last list and they were added only for media lists, they stop receiving email altogether."
3. Choose **Confirm remove**. You see "Removed from the list."

Nobody is emailed. If it was their last list and they were added only for media lists, their status becomes **Unsubscribed or deleted**, and **History** shows "Ended: removed from their last media list". You can add them back later without the unsubscribe question.

## Fix a member who needs attention

A flagged member shows the reason under **Needs attention**:

| Reason | What happened |
|---|---|
| **Bouncing** | Their last 10 emails in 15 days all bounced. They are still on the list and still sent email. |
| **Media Hub email removed** | The address they use was removed from their Media Hub contact. |
| **Media Hub email belongs to another subscriber** | Media Hub moved them to an address another record already has. |
| **Media Hub email isn't valid** | Media Hub has an address that isn't a real email address. |
| **Media Hub email opted out of a media list this member is on** | Media Hub moved them to an address that unsubscribed from one of their lists, so they were kept at their old address. |

To fix a bouncing member:

1. Check with Media Relations that their mailbox works again.
2. Choose **Resolve** and their address. The Hub asks "Clear the bouncing flag?" and explains "Do this once their mailbox works again. Their bounce count starts again from now."
3. Choose **Clear flag**. You see "Resolved. Their bounce count starts again."

To fix a Media Hub problem:

1. Choose **Resolve** and their address. **Resolve this member** shows their Media Hub addresses under **Choose the email to use**.
2. Choose the address to use, then **Use this email**. You see "Email updated and flag cleared."
3. Or choose **Clear the flag only** to keep their current address. You see "Flag cleared."

For **Media Hub email opted out of a media list this member is on**, **Clear the flag only** lasts only until the next Media Hub sync, which flags them again. You see "Flag cleared until the next Media Hub sync." To fix it for good, choose another of their addresses, update the contact in Media Hub, or remove them and add them again, confirming the unsubscribe.

## Left this list by unsubscribing

This section lists people who unsubscribed from this list themselves, with when they left and whether they are **Back on the list**. The most recent 200 are shown. People you removed are not listed.

## Media Hub sync

Every night, News On Demand picks up changed Media Hub contacts. **Media Hub sync** on **Media lists** shows when it last ran and what it changed.

To run it now, choose **Sync with Media Hub now**. You see "Sync finished." and its counts. A long sync may stop part-way: you then see "Sync stopped part-way and carries on at the next scheduled run."

## Can't do this?

| Message | What it means |
|---|---|
| "That isn't a valid email address." | Check the address. |
| "Media Hub isn't responding. Try again, or add the address by hand." | Media Hub is down. |
| "Media Hub isn't set up on this site. Add the address by hand instead." | This site has no Media Hub connection. |
| "That contact or email is no longer in Media Hub." | Search Media Hub again. |
| "A sync is already running. Try again in a few minutes." | Wait for the running sync to finish. |
| "That address belongs to another subscriber. Choose another email, or remove this member." | Pick a different address. |
| "That address opted out of a media list this member is on. Choose another email, update the contact in Media Hub, or remove them and add them again, confirming the opt-out." | The address you chose unsubscribed from one of their lists. Pick a different address. |
| "This member changed while you were looking. Close this, and try again." | Someone else changed them. Close the box and try again. |
| "Couldn't remove. Try again." | The removal didn't save. |
