---
id: bounces
title: Bounces
manual: nod-admin
order: 70
routes: []
screens: []
topics: []
---
**Who this is for:** Subscribers administrators (NoD.Admin).

A bounce is an email that comes back undelivered. A hard bounce means the address doesn't work, such as a mailbox that no longer exists. A soft bounce is temporary, such as a full mailbox.

## When a subscriber is disabled

When a subscriber's last 10 emails within 15 days have all hard-bounced, News On Demand acts on its own:

- A subscriber who is not on any media list is disabled. Their status becomes **Disabled — after repeated bounces**, and they get nothing more. Their record and lists are kept. The retention purge never deletes them.
- A media list member is never disabled. They are flagged **Bouncing** on **Media lists** and keep being sent email. Tell Media Relations.

A daily digest counts as one email, however many releases it lists. Soft bounces don't count, unless their code is listed under **Soft bounces counted as hard** on [Operations](manual:subscriber-operations).

A subscriber's record shows **Bounced emails counted (last 15 days)** once any have bounced.

## Bring a bounced subscriber back

- They can sign up again on the public site. The confirmation email reaching them proves the mailbox works.
- Or, once you know the mailbox works, open their record and choose **Activate**. Their bounce count starts again.

For a bouncing media list member, choose **Resolve** on the list. See [Media lists](manual:subscriber-media-lists).

## The daily bounce summary

The summary is emailed at 8:00 am to the address set on **Operations**, with the subject "News On Demand - Bounce Manager" and the date. It is sent only when something bounced since the last one.

It has these parts:

| Part | What to do |
|---|---|
| Bounce reports processed | The totals, including auto-replies and other messages that weren't bounces. |
| **Hard bounces**: count toward 10 in 15 days | One line per bounce: the address, the code and the outcome, such as recorded, disabled or flagged. |
| **Soft bounces**: not counted, usually no action needed | Usually nothing to do. |
| **Unrecorded bounces**: not counted; check the bounce mailbox | Bounces that matched no news email, such as a bounced sign-up confirmation. If an address keeps appearing and the line says "NoD subscriber", find and delete that subscriber. |

A line in bold is a media list member. Tell Media Relations each time one appears, even if they are already flagged. The soft and unrecorded parts stop at 500 lines each and say how many more there were; the rest are in the bounce mailbox.
