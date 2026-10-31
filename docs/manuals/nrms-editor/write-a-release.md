---
id: editor-write-a-release
title: Write a release
manual: nrms-editor
order: 30
routes: [/releases]
screens: [release]
topics: []
---
**Who this is for:** Release editors (NRMS.Editor).

At the top of a release you see its type, status, reference number and headline. If something is still missing, a line such as "Not ready: 2 things to fix." follows. Choose **See them under Actions** to go to the list, where each item links to the part to fix.

On a wide screen, the release is on the left, and **Actions**, **Publish settings** and **Release info** are on the right. On a narrow screen they come one after another.

## Save your changes

You can change several parts of the release, then save them all at once.

1. Make your changes. Each part you changed says **Unsaved** beside its heading.
2. A bar along the bottom lists them: "You have unsaved changes in: …".
3. Choose **Save changes** in that bar, or press Ctrl+S (Command+S on a Mac). Pressing Enter in a one-line field saves too.
4. The bar says "All changes saved." for a moment, then goes.

If one part can't be saved, the bar says "Couldn't save page details. See why in that section." Choose the link to go to the message. Parts after it are not saved yet and keep your changes.

While anything is unsaved, **Approve**, **Publish now** and **Schedule** are greyed out, with "Save your changes to … first." under them.

If you try to leave with unsaved changes, a box asks "Leave anyway and discard them?" Choose **Stay** to go back, or **Leave** to lose them; they don't come back the next time you open the release. If your sign-in runs out while you are writing, sign in again in the same browser tab: the text you typed in a document comes back, with "Your unsaved changes were restored." If someone changed the release in the meantime, it also says saving them will ask you to reload first, so your older text can't overwrite their newer changes.

"Someone else changed this — reload to see their changes." means another person saved this release after you opened it. Choose **Reload**. Copy anything you typed first, because reloading shows their version.

**If the release is already published, saving any change republishes it at once.** See [Correct, feature, unpublish or delete](manual:editor-correct-unpublish-delete).

## Documents

A release has one or more documents, such as the news release and a backgrounder. Each has an **English** tab, and a **French** tab once you add one.

Each document says its layout under its heading, such as "Layout: Formal". The layout decides one field:

- A **Formal** document has **Organizations**, marked "Needed before publishing." on a release, story or factsheet.
- An **Informal** document has a **Byline** instead.

Every document also has a **Page title**, **Headline**, **Subheadline**, **Body** and **Contacts**.

If a document already holds a byline but is Formal, or organizations but is Informal, that text shows, but can't be edited, with a note such as "A formal document doesn't keep a byline. It's removed the next time this tab is saved." Copy it first if you need it.

The **Body** toolbar has **Bold**, **Italic**, **Bulleted list**, **Numbered list**, **Link** and **Insert asset**. Pasted text keeps only that formatting.

To show a video or photo inside the body:

1. Put the cursor where it should go.
2. Choose **Insert asset**.
3. Paste a YouTube, Flickr or SoundCloud link and choose **OK**.

Up to 10 links in one body show as media. Others show as plain links, and so does a Flickr photo that isn't public when you save.

To add a contact, choose **Add contact** and type it in **Contact 1**. The first line is its title. A document can have up to 20.

To work with documents:

- **Add document**: enter its **Page title**, choose its **Layout**, then choose **Add**.
- **Move up** or **Move down**, or drag the handle, to change the order.
- **Remove**, then **Confirm remove**, deletes the document and its French text. This can't be undone. A release always keeps one document.

## French text

1. Choose **Add French translation** on the document.
2. Choose the **French** tab and fill it in. Once the French tab exists, its headline and body, and on a Formal document its organizations, must be filled in before you can publish.
3. To take it away, choose **Remove French translation**, then **Confirm remove**. This can't be undone.

A French PDF goes under **Files** instead. See [Photos, video and files](manual:editor-files-and-media).

## Page details

- **URL key**: the last part of the release's public address. A release or advisory gets one when it is approved. A story's or factsheet's comes from its headline, and you can change it until it is scheduled.
- **Redirect URL**: fill this in only to send visitors to another page instead.
- **Location**: the place at the start of the release, up to 50 characters.
- **Summary**: what subscribers see in their email. It fills itself from the start of the body. **Documents** shows it, with "(auto)" until you change it, and an **Edit it in Page details** link.
- **Social media summary** and **Keywords**.

Advisories have no summary, social media summary or keywords.

## Categories

**Categories** shows what is ticked. Choose **Edit categories** to change the **Ministries**, **Lead ministry**, **Sectors**, **Themes** and **Tags**. Once you tick more than one ministry, **Lead ministry (needed before approving)** appears and says "Choose the lead ministry" until you do. An advisory doesn't need one and offers **(none)**.

These decide which subscribers are emailed and which public pages list the release. You need at least one ministry and one sector to publish, and a lead ministry when you tick more than one.

## Similar published releases

Use it to check whether something like this has gone out before.

1. Save first: it compares the release as last saved.
2. Choose **Open similar-release search**, then **Find similar**.
3. You see up to 10 published releases, each with its date, lead ministry, **AI match** or **Text match**, and a link that opens the public page in a new tab.

Nothing is sent until you choose **Find similar**. Where the site uses AI matching, the panel says "Sends this draft's text to the AI service to compare." If that service isn't available, you get text matches and the panel says so.

## Release info

- **Key** and **Reference (NEWS number)**, or "(none yet)".
- **View on site** opens the public page. It works only while the release is published.
- **View PDF** opens the release as a PDF.
- **Email me a copy** emails the release to you. You see "Sent to" and your address.
- **History** lists what was done and by whom. Tick **Show all** to include every edit. **Published copies** lists each time it went out.
