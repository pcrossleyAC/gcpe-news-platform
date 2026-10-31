---
id: website-files
title: Files
manual: nrms-site-editor
order: 50
routes: [/website/files]
screens: [website]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Files** holds documents and images the public can open at a fixed web address, such as a media guide or a minister's photo. You can upload any type of file of up to 512 MB.

The list shows the 50 newest files. Under each file's name is its full public address, the one visitors use, such as https://news.gov.bc.ca/files/media-guide.pdf. To find an older file, type part of its name in **Search files** and choose **Search**.

## Upload a file

1. Choose **Upload a file (any type, up to 512 MB)** and pick the file.
2. The file appears at the top of the list when the upload finishes.

The file's public name is made from your file name: in lower case, with spaces and any character other than letters, digits, dots, hyphens and underscores turned into hyphens. For example, "Media Guide 2026.PDF" becomes media-guide-2026.pdf. Its public address ends in /files/ and that name, as in /files/media-guide-2026.pdf.

PDFs, images, Office documents, audio, video and text open in the visitor's browser. Anything else, such as a web page, an SVG drawing or a program, is downloaded, never shown on the site.

## Use a file elsewhere

To put a file in a minister's photo on [Organizations](manual:site-editor-organizations), a slide, an emergency pin, a banner link or a link on [Resource links](manual:resource-links):

1. Choose **Copy public address** beside the file. You see "Copied the public address of {name}." While the page is still working out the public address, the button is greyed out and the page says "Working out the public address…".
2. Paste the address into the other screen's web address box.

Don't copy the address from your browser's address bar while you are in the Hub. That address points at the Hub's own server, which the public can't open: you would see the file, but visitors would get a broken image or link. A web address box holding such an address says "This address points at the Hub, which the public can't open. On Website → Files, use Copy public address and paste that instead."



## Replace a file

Replacing keeps the file's name and address, so every link to it keeps working.

1. Upload a file with the same name. A box says "A file named "{name}" already exists".
2. Choose **Replace it**. To keep the old file instead, choose **Cancel** and rename your file.

Visitors may see the old copy for up to a minute.

## Delete a file

1. Choose **Delete {name}** beside the file.
2. A box asks "Delete {name}?" and warns "This deletes the file from the public site. It can't be undone."
3. Choose **Confirm delete**.

Links to a deleted file stop working. Check that nothing still points to it first.

## What happens next

- **Website log** lists each upload, replacement and deletion under **Files**, with the file's name and yours.
- Nobody is emailed.

## Can't do this?

| Message | What it means |
|---|---|
| "{name}: A file can be at most 512 MB." | The file is too big to upload. |
| "The file is empty." | The file has nothing in it. Check you picked the right one. |
| "{name}" is a reserved Windows device name; rename the file. | Names such as con, aux, nul or prn can't be used. Rename the file and upload it again. |
| "Couldn't work out the public address. Reload the page." | The Hub couldn't find out the public site's address, so it shows no addresses and won't copy one. Reload the page. If it keeps happening, tell the support team. |
| "Couldn't copy. Select the address of {name} and copy it." | Your browser didn't allow the copy. Select the address under the file's name and copy it yourself. |
| "The upload wasn't accepted. Reload the page and try again." | Most often this happens just after the Hub was updated: a page left open from before the update sends the file in a way the Hub no longer accepts. |
