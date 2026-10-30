---
id: emergency-pins
title: Emergency pins
manual: nrms-site-editor
order: 20
routes: [/website/pins]
screens: [website]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Emergency pins** holds two emergency notices, **Primary** and **Secondary**. A pinned notice shows on the public home page under the **Emergency information** heading, above the news. An unpinned one is kept here but not shown.

Each notice has the same fields as a carousel slide: headline, summary, action URL, action label, Facebook post URL, justify and an image.

## Write a notice

1. Fill in the notice's fields, such as **Primary headline** and **Primary summary**.
2. Choose **Save primary pin** (or **Save secondary pin**).

If the notice is already pinned, the change goes to the public site when you save.

## Pin or unpin a notice

Save the notice first. Pinning reloads the notice, and any change you haven't saved is lost.

1. Choose the switch beside **Primary is not pinned**. It saves at once, with no question, and now reads **Primary is pinned**.
2. To take the notice down, choose the switch again.

## Add or change the image

1. Choose **Primary image (JPEG or PNG, up to 2 MB)** and pick the file.
2. The image appears above the button. It saves at once. On a pinned notice, the public site changes too.

## What happens next

- The public home page shows the change within a few minutes.
- Every save, pin and unpin is listed in **Website log** under **Emergency pins**.

## Can't do this?

| Message | What it means |
|---|---|
| "Add a headline before pinning." | The saved notice has no headline. Enter one, choose **Save primary pin**, then pin it. |
| "invalid request" | A web address doesn't start with http:// or https://. Check the action URL and the Facebook post URL. |
| "Keep the action label to 40 characters or fewer, in plain text." | Shorten the action label, and remove any < or > characters. |
| "Upload a JPEG or PNG image." | The file isn't a JPEG or PNG image. |
| "request entity too large" | The image is bigger than 2 MB. |
| "Someone else changed this — reload to see their changes." | Another site editor changed this notice while you had the page open. Choose **Reload**. |
