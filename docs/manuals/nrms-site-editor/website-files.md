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

The list shows the 50 newest files, each linked to its public address. To find an older one, type part of its name in **Search files** and choose **Search**.

## Upload a file

1. Choose **Upload a file (any type, up to 512 MB)** and pick the file.
2. The file appears at the top of the list when the upload finishes.

The file's public name is made from your file name: in lower case, with spaces and any character other than letters, digits, dots, hyphens and underscores turned into hyphens. For example, "Media Guide 2026.PDF" becomes media-guide-2026.pdf. Its public address ends in /files/ and that name, as in /files/media-guide-2026.pdf.

PDFs, images, Office documents, audio, video and text open in the visitor's browser. Anything else, such as a web page, an SVG drawing or a program, is downloaded, never shown on the site.

To use a file elsewhere, such as a minister's photo on [Organizations](manual:site-editor-organizations) or a link on [Resource links](manual:resource-links), open it from the list and copy the full address from your browser's address bar.

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
| "The upload wasn't accepted. Reload the page and try again." | Most often this happens just after the Hub was updated: a page left open from before the update sends the file in a way the Hub no longer accepts. |
