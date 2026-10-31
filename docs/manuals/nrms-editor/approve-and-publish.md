---
id: editor-approve-and-publish
title: Approve, publish and schedule
manual: nrms-editor
order: 50
routes: []
screens: [release]
topics: []
---
**Who this is for:** Release editors (NRMS.Editor).

A release goes from **Draft** to **Approved**, then out now or at a set time. **Actions** shows only the buttons that fit the release's status. Each step acts on the release as saved, so save your changes first.

When a button is greyed out, the reasons are listed under it, such as "Approve is unavailable until:" and "Choose at least one ministry.". On a draft, "Also needed before it can be published:" lists what publishing will need too. A scheduled release can still have something missing, listed under "Before the scheduled time:", and a published one under "Before your next save can republish it:", because each publish checks again. Each reason links to the part of the release to fix.

## Approve

1. Choose **Approve**. A box asks "Approve this release?"
2. If the release still has placeholder text, such as "TBD", "TBC", "to come", "XX" or "[insert", the box lists where. Fix it, or choose **Approve anyway** if it is meant to be there.
3. Choose **Approve**.

The release gets a reference number, such as NEWS-00010. A release or advisory also gets its release number, such as 2026HLTH0003-000008, which becomes its public address. **Publish now** and **Schedule** appear. Nobody is emailed.

To approve, a release needs at least one ministry, and a lead ministry when it has more than one. "This ministry is no longer active. Change the lead ministry to its successor before approving." means the lead ministry was replaced; choose the new one in **Categories**.

## Publish now

1. Choose **Publish now**. A box asks "Publish this release now?" and lists what will happen:
   - where it is published, such as "Publishes to news.gov.bc.ca now.";
   - which media distribution lists it is sent to, or "No media distribution lists.";
   - which News On Demand subscribers are emailed, such as "Emails News on Demand subscribers who follow any of: Health — and everyone subscribed to all news.", or "News on Demand subscribers will not be emailed."
2. Check the list. Choose **Publish now**.

The status shows **Publishing...**, then **Published**, usually within a minute. The page updates by itself: "This page updates on its own until the release is done — no need to reload."

## Schedule

1. Choose **Schedule**. If the release has a planned publish date still ahead, the date and time are filled in from it, and the panel says "Filled in from the planned publish date."
2. Enter the **Date** and **Time (BC time)**. A time that has passed shows "Choose a time in the future, or use Publish now."
3. Choose **Confirm schedule**. A box asks, for example, "Schedule this release for Friday, November 20, 2026 at 10:00 AM Pacific time?" and lists who will be emailed, as for **Publish now**.
4. Choose **Schedule**.

The release moves to **Scheduled**. At that time it publishes by itself and the emails go out. Until then nothing is public: not the page, not its files, not the emails.

You can still change a scheduled release. What goes out is the release as saved at the publish time.

## The planned publish date

**Planned publish date (for planning only)**, in **Publish settings**, is a plan: nothing happens at that time. It shows on **Forecast** and makes the status **Planned**. Choose **Clear planned date** to remove it. Only **Schedule** sets when the release goes out.

## Who is emailed

Set this in **Publish settings** before you publish.

- **Send to News On Demand subscribers**: ticked for releases, unticked for stories and factsheets, and not available for advisories.
- **Media distribution lists**: tick each list that should get the media email. With none ticked, no media email goes out. On a release brought over from the old system you may see "As saved, these lists won't get the media email. Save Publish settings and they will." **Publish settings** then says **Unsaved**: choose **Save changes** and the ticked lists get it. If that release went out before and is now off the site, it says "As saved, these lists won't get the media email when it's republished." instead, and nothing is marked unsaved: the old system may already have emailed those lists. A retired list a release already had shows "(retired)" and gets nothing; if only retired lists are ticked, the section says "The ticked lists are retired and won't get the media email."

See [Who is emailed, and when it goes public](manual:editor-what-happens-next).

## Take back an approval or a schedule

- **Cancel schedule** stops a scheduled release from going out. It goes back to **Drafts** as approved, and its time stays as the planned date. It doesn't ask first.
- **Return to draft** makes an approved or scheduled release a draft again. A box asks "Return this release to draft?" and says it gives up its reference number and release number; it gets new ones when it is approved again. Choose **Return to draft**. This is only for a release that has never been published.

## If publishing fails

The status shows **Failed** and the release goes back to **Drafts**. A red box headed "This release failed" says why. Fix it, save, and choose **Publish now** or **Schedule** again.

Other refusals you may see:

| Message | What it means |
|---|---|
| "Set a URL key in Page details before this can be published." | A story or factsheet needs a URL key. |
| "The lead ministry has no abbreviation yet. Ask an administrator to add one, then approve again." | Ask a Core administrator to add the ministry's abbreviation, then approve. |
| "That number is already in use — try again." | Two releases were approved at the same moment. Approve again. |
| "The publish time is more than 5 minutes in the past." | Choose a later time. |
| "A live release's correction goes out immediately — choose Publish now." | A failed correction of a published release can't be scheduled, so **Schedule** isn't offered for it. If you see this, reload the page and choose **Publish now**. |
