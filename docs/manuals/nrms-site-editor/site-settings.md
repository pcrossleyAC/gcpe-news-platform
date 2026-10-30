---
id: site-settings
title: How site settings are published
manual: nrms-site-editor
order: 70
routes: [/website/settings, /website/settings-history]
screens: [website/settings]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Website** > **Site settings** lists the screens that set how the public site looks and reads: **Banner**, **Footer**, **Social links**, **Theme**, **Ministry pages**, **Media contacts page**, **Page text**, **Navigation and labels** and **Site identity**. They all save and publish the same way. **Settings history** lists everything published so far.

## Your draft

You have one private draft that covers all of these screens. Other site editors have their own, and nobody else sees yours.

- **Save draft** keeps your changes in your draft. The public site doesn't change.
- **Publish** puts your whole draft live: the changes on this screen, and any you saved as a draft on other settings screens.
- **Discard draft** throws your draft away, on every settings screen, with no question. The screen then shows what is live: "Draft discarded. Showing what is live."

The foot of each screen says where you are. "Draft saved · not yet live" means you have a draft; "No unpublished changes" means you don't. The next line shows the live revision, who published it and when.

## Publish a change

1. Make the change on the settings screen.
2. If you like, type a **Note for the history log (optional)**, such as "Election notice". It shows in **Settings history** and **Website log**.
3. Choose **Publish**. You see "Published revision 5. Visitors see it within a few minutes." (with the new number).

If the draft has a problem, nothing is published. You see "Draft saved, but it has problems to fix before it can be published." Each problem shows under its field. A problem on another settings screen shows in a list headed "Other parts of the draft have problems that block publishing:", with the name of that screen. Fix it there, or choose **Discard draft** to start again from what is live.

## If someone else published first

When another site editor publishes while you are working, your **Publish** doesn't go through. You see "Someone published while you were editing", with who published and when, and "Nothing of yours was published, and your draft is saved." It also lists the screens where your draft differs.

Choose one:

- **Keep my banner, on top of their version** (the button names the screen you are on, such as "Keep my footer"): your changes on this screen are added to what they published. Changes you saved on other screens are set aside, and the message names them. Check the result, then choose **Publish**.
- **Discard mine, use theirs**: your draft is thrown away and the screen shows what is live.

## Bring back an earlier version

**Settings history** lists every published revision, newest first, with **Revision**, **When**, **Who** and **Note**. The live one is marked **Live**.

1. Choose **Restore…** on the revision you want.
2. A box asks "Restore revision 1?" and lists the screens it would change, such as "Compared with what is live now, this changes: Footer." If the banner changes, it says what the banner would be.
3. Choose **Restore revision 1**. You see "Revision 1 is live again, as revision 6."

Nothing is ever deleted. A restore is published as a new revision, so you can undo it by restoring the one before. Restoring also throws away your own draft.

## What happens next

- Visitors see a published change within a few minutes. Colours and the banner show quickest. A footer change reaches every page over the following minutes.
- **Website log** lists each publish under **Site settings**, such as "Published revision 5: Election notice".
- Nobody is emailed.

## Can't do this?

| Message | What it means |
|---|---|
| "Nothing was restored: revision {n} was published while you were looking. Check it and try again." | Someone published while the restore box was open. The list is now up to date. |
| "Revision {n} can't be restored: it doesn't pass the checks the site settings must meet now." | The old revision breaks a rule added since. Make the change by hand instead. |
| "Revision {n} no longer exists." | Reload the page. |
| "Couldn't load the site settings." | Reload the page. If it keeps happening, tell the support team. |
