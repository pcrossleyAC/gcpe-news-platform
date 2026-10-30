---
id: subscriber-media-lists
title: Media lists
manual: nod-admin
order: 40
routes: [/subscribers/media-lists]
screens: [subscribers]
topics: []
---
**Who this is for:** Subscribers administrators (NoD.Admin).

**Media lists** holds the reporters on each media list. Release editors pick these lists on a release, and every member gets the full-text media version.

The table shows each list's **Members**, how many **Need attention**, and its **Status**. A **Retired** list can no longer be put on a release. Core administrators add, rename and retire lists on **Media list names**.

Choose a list's name to open it.

## Add a reporter from Media Hub

1. Open the list.
2. Under **Add from Media Hub**, type a name, email or outlet in **Name, email or outlet**.
3. Choose **Search Media Hub**. Each contact shows their addresses, with the preferred one marked.
4. Choose **Add** and the address you want. You see "Added to the list."

## Add an address by hand

Use this for people who aren't in Media Hub.

1. Open the list.
2. Under **Add an address by hand**, enter the **Email address**.
3. Choose **Add to list**. You see "Added to the list."

## What adding does

- The reporter is not emailed. They get the next release sent to this list.
- A new address gets a record that receives media email only.
- If the address already has a record that is **Disabled** or **Unsubscribed or deleted**, adding makes it **Active** again. A person who had unsubscribed gets media email only.
- A **Disabled** person keeps their old news lists, so they also start getting news release email again, even if staff deactivated them. History shows only "Added to a media list". A person disabled by bounces keeps their old bounce count, so further bounces flag them **Bouncing**, and they keep being sent media and news release email.
- Before adding, check the address on **Find subscribers**. If it is **Disabled**, ask whether they want news release email again. If not, add them, then straight away open their record, untick **As it happens**, **Daily digest** and their lists, and choose **Save preferences**. This can't be done before adding: a record with no lists is refused unless it is on a media list.
- If the person left this list by unsubscribing, the Hub asks "This person unsubscribed" and says when. Choose **Add anyway** only if they have asked to get media releases again.

## Remove a reporter

1. Open the list.
2. Choose **Remove** and their address on their row. The Hub asks "Remove [their address] from this list?" and explains "If this is their last list and they were added only for media lists, they stop receiving email altogether."
3. Choose **Confirm remove**. You see "Removed from the list."

Nobody is emailed. If it was their last list and they were added only for media lists, their status becomes **Unsubscribed or deleted**. You can add them back later without the unsubscribe question.

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
2. Choose **Resolve** and their address. The Hub asks "Clear the bouncing flag?"
3. Choose **Clear flag**. You see "Resolved. Their bounce count starts again."

To fix a Media Hub problem:

1. Choose **Resolve** and their address. **Resolve this member** shows their Media Hub addresses.
2. Choose the address to use, then **Use this email**. You see "Email updated and flag cleared."
3. Or choose **Clear the flag only** to keep their current address. For an opted-out address, the next Media Hub sync flags them again. Update the contact in Media Hub instead, or remove them and add them again.

## Left this list by unsubscribing

This section lists people who unsubscribed from this list themselves, with when they left and whether they are **Back on the list**. The most recent 200 are shown.

## Media Hub sync

Every night, News On Demand picks up changed Media Hub contacts. **Media Hub sync** shows when it last ran and what it changed.

To run it now, choose **Sync with Media Hub now**. You see "Sync finished." and its counts. A long sync may stop part-way and carry on at the next scheduled run.

## Can't do this?

| Message | What it means |
|---|---|
| "That isn't a valid email address." | Check the address. |
| "Media Hub isn't responding. Try again, or add the address by hand." | Media Hub is down. |
| "Media Hub isn't set up on this site. Add the address by hand instead." | This site has no Media Hub connection. |
| "That contact or email is no longer in Media Hub." | Search Media Hub again. |
| "A sync is already running. Try again in a few minutes." | Wait for the running sync to finish. |
| "That address belongs to another subscriber. Choose another email, or remove this member." | Pick a different address. |
| "This member changed while you were looking. Close this, and try again." | Someone else changed them. Close the box and try again. |
| "Couldn't remove. Try again." | The removal didn't save. |
