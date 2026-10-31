---
id: carousel
title: Carousel
manual: nrms-site-editor
order: 10
routes: [/website/carousel]
screens: [website]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

The carousel is the set of slides at the top of the public home page. Visitors see one slide at a time and move between them with **Previous** and **Next**; the slides don't turn by themselves.

**Carousel** has three parts:

- **Live**: the slides visitors see now.
- **Next**: a copy you can prepare ahead, with a time when it replaces the live slides. There is at most one.
- **Past**: the last five sets that were replaced, for reference. You can't change them.

Each slide has a **Headline**, **Summary**, **Action URL** (where the slide's link goes), **Action label** (the link's words), **Facebook post URL**, **Justify** (**Left** or **Right**) and an image.

## Change the live slides

Changes to the live slides go to the public home page when you publish them.

1. Change what you need in a slide's fields.
2. To move a slide, choose **Move up** or **Move down** on it, or drag it by its handle.
3. To remove a slide, choose **Remove** on it, then **Confirm remove**. It leaves the live slides when you publish.
4. To add a slide, choose **Add slide** and fill in its fields.
5. Choose **Publish carousel changes**. A box asks "Publish these carousel changes now?"
6. Choose **Publish carousel changes** again to confirm.

Leave **Action label** empty to use the standard link words, set on [Navigation and labels](manual:footer-and-navigation).

## Add or change a slide's image

Use a JPEG or PNG image of up to 2 MB. Any slide can take an image, including one you have just added.

1. Choose the slide's **Image (JPEG or PNG, up to 2 MB)** button and pick the file.
2. What happens next depends on the slide:
   - **On the live slides**, the slide says "New image chosen:" and the file's name. The image goes live with your other changes when you choose **Publish carousel changes** and confirm. Until then the slide keeps the image it had. **Website log** notes that you chose it.
   - **On a slide you have just added to the next slides**, the image is saved when you choose **Save carousel**.
   - **On a slide already saved in the next slides**, the image saves as soon as you choose it. Nothing changes on the public site.

## Prepare the next slides

1. Under **Next**, enter the **Date** and **Time (BC time)** in **Go live at (BC time)**.
2. Choose **Create next carousel**. It starts as a copy of the live slides, images included.
3. Change, add, remove and reorder slides as above.
4. Choose **Save carousel**. Nothing changes on the public site.

At the go-live time, the next slides replace the live ones by themselves, and the old live slides move to **Past**. To change the time, enter a new one in **Go live at (BC time)** and choose **Save carousel**.

To switch now instead, choose **Make live now**, then **Confirm make live**.

To throw the next slides away, choose **Delete next carousel**, then **Confirm delete**. This can't be undone.

## What happens next

- The public home page shows published changes within a few minutes.
- Every change is listed in **Website log** under **Carousel**, with your name.

## Can't do this?

| Message | What it means |
|---|---|
| "Slide 2: Enter a full web address for Action URL, starting with http:// or https://" | The web address in **Action URL** (or **Facebook post URL**) on that slide is wrong. Start it with http:// or https://, or empty the box. Nothing is saved until every address is right. |
| "Keep the action label to 40 characters or fewer, in plain text." | Shorten the **Action label**, and remove any < or > characters. |
| "Choose a go-live time in the future." | The go-live time has already passed. |
| "Upload a JPEG or PNG image." | The file isn't a JPEG or PNG image. |
| "That image is over 2 MB. Choose a smaller image." | Make the image smaller and try again. |
| "Choose slide 2’s image again." | The image you chose for that slide wasn't kept. Pick the file again, then publish or save. |
| "Someone else changed this — reload to see their changes." | Another site editor saved these slides while you had the page open. Choose **Reload**. Your unsaved changes are lost, so make them again. |
