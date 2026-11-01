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

**Website** > **Site settings** lists the screens that set how the public site looks and reads: **Site banner**, **Footer links**, **Social links**, **Theme colours**, **Ministry page headings**, **Media contacts page**, **Page text**, **Navigation and labels** and **Site identity**. They all save and publish the same way. **Settings history** lists everything published so far.

## Your draft

You have one private draft that covers all of these screens. Other site editors have their own, and nobody else sees yours.

- **Save draft** keeps your changes in your draft. The public site doesn't change.
- **Publish** puts your draft live: the changes on this screen, and any you saved as a draft on other settings screens. It asks first, and can publish only this screen instead (see below).
- **Discard draft** throws your whole draft away, on every settings screen. A box asks "Discard your whole draft?" and names the other screens it clears, such as "This also throws away your draft changes on Theme colours and Footer links." If you have typed something on this screen and not saved it, the box says that goes too. Choose **Discard draft** to confirm, or **Cancel**. The screen then shows what is live: "Draft discarded. Showing what is live."

The foot of each screen says where you are. "Draft saved · not yet live" means you have a draft; "No unpublished changes" means you don't. With a draft, "Your draft has changes on:" names each screen it changes, with a link to it. The next line shows the live revision, who published it and when. Above the buttons, "Publish and Discard draft apply to your whole draft, on every settings screen. Publish lets you publish only this screen instead."

## If you leave before saving a draft

If you have changed this screen and not chosen **Save draft**, the Hub asks before you go to another screen, including another settings tab such as **Site banner** or **Footer links**: "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard what you typed since your last **Save draft**. Your saved draft is kept either way. Closing or reloading the tab gets your browser's own question.

## Publish a change

1. Make the change on the settings screen.
2. If you like, type a **Note for the history log (optional)**, such as "Election notice". It shows in **Settings history** and **Website log**.
3. Choose **Publish**. A box asks "Publish your changes?" and lists the screens whose changes go live, such as "Compared with what is live now, this publishes changes on: Site banner and Footer links." Anything you have typed on this screen counts, even if you haven't saved it.
4. Choose **Publish** to confirm, or **Cancel**. You see "Published revision 5. Visitors see it within a few minutes." (with the new number).

### Publish only this screen

When your draft also has changes on other settings screens, the box offers two buttons instead of **Publish**:

- **Publish only Site banner** (the button names the screen you are on): only this screen's changes go live. Your changes on the other screens stay in your draft, unpublished. You see "Published revision 6, with only your Site banner changes. Visitors see it within a few minutes. Your draft still has changes on Footer links." In **Settings history** and **Website log**, the revision's note starts "Banner only", so it is clear that only that part was published.
- **Publish all changes**: your whole draft goes live, as before.

Use **Publish only** when something is urgent, such as an emergency banner, and you haven't finished or checked the other screens. It works even if someone else has published other screens since you started your draft: what they published stays live, and your draft keeps your other changes. You can use **Publish only** on the same screen again, for example to fix a typo. It stops only if someone else has changed this same screen since you started (see "If someone else published first"). If another screen in your draft has a problem, the box says so, such as "Footer links has problems that block publishing all changes. Publish only Site banner still works."

If the changes being published have a problem, nothing is published. You see "Draft saved, but it has problems to fix before it can be published." Each problem shows under its field. A problem on another settings screen shows in a list headed "Other parts of the draft have problems that block publishing:", led by a link to that screen. Fix it there, or choose **Discard draft** to start again from what is live.

## Links to files

To link to a file from **Files**, such as a PDF in the footer, a banner link or the Connect page's **Policy link URL**, paste the address from its **Copy public address** button. An address copied from the Hub itself shows "This address points at the Hub, which the public can't open. On Website → Files, use Copy public address and paste that instead." under its **Web address**: visitors couldn't open it. It shows for the Hub's other known web addresses too, not just the one you are using.

## If someone else published first

When another site editor publishes while you are working, your **Publish** doesn't go through. You see "Someone published while you were editing", with who published and when, and "Nothing of yours was published, and your draft is saved." It also lists the screens where your draft differs.

Choose one:

- **Keep my site banner, on top of their version** (the button names the screen you are on, such as "Keep my footer links"): your changes on this screen are added to what they published. Changes you saved on other screens stay in your draft too. If they changed one of those screens as well, the message names it, such as "Your draft still has your changes on Footer links, which they changed too: check them before you publish them." Check the result, then choose **Publish**.
- **Discard mine, use theirs**: your draft is thrown away and the screen shows what is live.

## Bring back an earlier version

**Settings history** lists every published revision, newest first, with **Revision**, **When**, **Who** and **Note**. The live one is marked **Live**.

1. Choose **Restore…** on the revision you want.
2. A box asks "Restore revision 1?" and lists the screens it would change, such as "Compared with what is live now, this changes: Footer links." If the banner changes, it says what the banner would be.
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
