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
- An address that is already **Active** keeps its news release email as it was.
- If the address already has a record that is **Disabled** or **Unsubscribed or deleted**, adding makes it **Active** again, for media email only. **As it happens**, **Daily digest** and their news lists are switched off. Media lists they were already on are kept.
- For a **Disabled** person, their bounce count starts again, and **History** shows "Added to a media list while Disabled. News release email stays off", with what was switched off under **Detail**.
- When the address was **Disabled**, you see "Added to the list. Their news release email stays off; open their record to turn it on." instead of "Added to the list."
- If a **Disabled** person also wants news release email again, choose **open their record** in that message. Tick **As it happens** or **Daily digest** and their lists, then choose **Save preferences**.
- When you add someone, the Hub may ask "This person unsubscribed" and say when. It asks only when its records show this address may have unsubscribed since it was last added to this list: from this list, from all News On Demand email, or in the old News On Demand system. Check with them, or with whoever asked you to add them, before you choose **Add anyway**. Adding them back clears the question for this list, unless they unsubscribe again.

## Remove a reporter

1. Open the list.
2. Choose **Remove** and their address on their row. The Hub asks "Remove [their address] from this list?" and explains "If this is their last list and they were added only for media lists, they stop receiving email altogether."
3. Choose **Confirm remove**. You see "Removed from the list."

Nobody is emailed. If it was their last list and they were added only for media lists, their status becomes **Unsubscribed or deleted**. Removing them isn't an unsubscribe, so it doesn't by itself make the Hub ask when you add them back.

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

## Left this list

This section lists people who left this list, with when they left and whether they are **Back on the list**. The screen explains "They unsubscribed, or left it in the old system." Someone you removed in the Hub isn't listed. The most recent 200 are shown.

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
