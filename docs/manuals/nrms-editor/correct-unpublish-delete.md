---
id: editor-correct-unpublish-delete
title: Correct, feature, unpublish or delete
manual: nrms-editor
order: 70
routes: []
screens: [release]
topics: []
---
**Who this is for:** Release editors (NRMS.Editor).

## Correct a published release

1. Open the release and make the change. The bar along the bottom says "Saving republishes this release on the public site."
2. Choose **Save and republish**.

It republishes at once: no box asks first. Pressing Enter in a one-line field or Ctrl+S (Command+S on a Mac) saves and republishes too, so finish the whole correction before you press either. The status shows **Republishing...**, then **Published**, usually within a minute. **History** shows "Republished to …"; with **Show all** ticked it also shows "Edited after publishing — will republish". The public page shows the change within a couple of minutes. Nobody is emailed again, unless you choose to (below). Under **Actions** you then see "Republished. People who already got it weren't emailed again. To send them the corrected version, use Email the correction."

## Email the correction

If people need to know about the change, you can email the corrected release again to the people who already got it.

1. Save your changes first. While anything is unsaved, **Email the correction** is greyed out and says "Email the correction is unavailable until:".
2. Under **Actions**, choose **Email the correction**. A box asks "Email the correction?" and says "This republishes the release as saved, then emails it again to the people you tick."
3. Under **Also email it again?**, tick **News on Demand subscribers who got it**, **Media list contacts who got it**, or both. Each says how many people that is, such as "(1,200 people)". Nothing is ticked to start. "(nobody to email)" means nobody got it that way, so that box can't be ticked. The subscribers box shows only while **Send to News On Demand subscribers** is ticked in **Publish settings**; the media lists box, while the release goes to a media list. If a correction was emailed before, the box warns, for example, "Already emailed a correction on Oct 31, 2026 2:15 PM, asked for by Pat Editor. This sends another to the same people."
4. Choose **Republish and email**.

It republishes, then the people you ticked get the release as it is now, with "Corrected:" before the usual subject, such as "Corrected: BC Gov News - Highway 1 reopens". Only people who already got it, and are still subscribed, are emailed. Nobody new is. Someone who got both a subscriber and a media email gets one corrected copy, the media one. When both are ticked, the box says how many people that is in all, such as "Emails 1,500 people again. 12 people in both get one copy, the media one."

**History** shows "Asked to email it again to subscribers who got it" with your name, then, as it republishes, "Passed to News On Demand: email it again with "Corrected:" to subscribers who got it (correction 1, as <your name> asked)". Until it republishes, **Actions** says "Emailing it again to subscribers who got it is waiting for it to republish."; if you choose **Email the correction** again meanwhile, your ticks are added to the waiting ones. Then, until News On Demand has it, **Actions** says "The corrected email asked for on … is on its way to News On Demand." If News On Demand never received it, a red box says "The corrected email asked for on … didn't reach News On Demand, so nobody was emailed. Choose Email the correction to send it again."

You can email a correction more than once; each time is a new email to the same people. If News On Demand sending is paused, the corrected email waits with the rest and a Subscribers administrator can cancel it. Someone whose first email is still waiting gets the corrected release as their first email instead, without "Corrected:", and no second copy.

Advisories are emailed again to media lists only. An update, which is never emailed, has no **Email the correction**.

Uploading or removing a file counts as a correction too. If a correction fails, the release shows "This release failed" and stays on the public site as it was. Fix the problem, save, then choose **Publish now**. **Schedule** isn't offered: a failed correction goes out at once. The **Publish now** box asks **Also email it again?** as described under **Email the correction** above.

## Top and Feature spots

Each place on the public site has one Top and one Feature spot: the home page, and each ministry, sector and theme page. A release can take them only while it is published.

1. Open the release. **Top / Feature** says where it is now, such as "Feature on Home", or "Not in a Top or Feature slot anywhere."
2. Choose **Change Top / Feature**. You see **Home** and each ministry, sector and theme the release is filed under, as saved. One you have ticked in **Categories** but not saved shows "Save to feature here." with no switch; choose **Save changes** first.
3. Switch **Top** or **Feature** on or off for a place.

It changes at once, without **Save changes**, and doesn't republish the release or email anyone. Switching a spot on takes it over from whichever release had it. To see every spot at once, go to **Website** > **What's featured where**.

## Unpublish

Advisories can't be unpublished.

1. Choose **Unpublish**. A box asks "Unpublish this release?"
2. Choose **Confirm unpublish**.

The status shows **Unpublishing...**, then the release goes back to **Drafts**, usually within a minute. Its page and files come off the public site, it leaves any Top or Feature spot, and emails not yet sent are stopped. See [Who is emailed, and when it goes public](manual:editor-what-happens-next).

To put it back, choose **Publish now** or **Schedule**. It keeps its numbers and its web address, even if you change its headline while it is off the site. People who already got it aren't emailed again unless you tick them under **Also email it again?** in the box, which works as described under **Email the correction** above. Unpublishing drops an **Email the correction** that hadn't gone out yet, and **Cancel schedule** drops the ticks you chose for that schedule.

## Delete

You can delete a draft, an approved release or a failed one. A published release, including one whose correction failed, must be unpublished first; until then it has no **Delete**.

1. Choose **Delete**. A box asks "Delete this release?"
2. Choose **Confirm delete**. You are taken to **Drafts**.

- A draft that was never approved is deleted for good: "This draft has never been approved — deleting it is permanent and can't be undone."
- A release with a reference number disappears from the folders and **Search**, but its record is kept: "This release has a reference number (NEWS-00010) — deleting it hides it from the lists but keeps the record."
