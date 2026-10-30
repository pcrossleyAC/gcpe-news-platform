---
id: site-banner
title: Site banner
manual: nrms-site-editor
order: 80
routes: [/website/banner]
screens: [website/settings]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

The banner is a notice across the top of every public page, such as planned maintenance or an emergency. Open it from **Website** > **Site settings** > **Site banner**. Like every site setting, it changes the public site only when you publish. See [How site settings are published](manual:site-settings).

## Put up a banner

1. Under **Banner type**, choose **Information** or **Emergency**. Emergency uses the emergency banner colour, set on [Theme colours](manual:theme-colours).
2. Type the **Message**: plain text, up to 300 characters. The count shows below the box.
3. To add a link, choose **+ Add a link**, then fill in **Link text** and **Web address**. Add more the same way. **Remove link 1** takes one away.
4. To show it later, enter **Show from**. To take it down by itself, enter **Hide after**. Both are BC time. Leave **Show from** blank to show it at once, and **Hide after** blank to keep it up until you turn it off.
5. Tick **Visitors can close the banner** to give it a close button (×).
6. Check the **Preview**. It shows roughly how the banner looks.
7. Choose **Publish**.

The banner switches on and off by itself at the **Show from** and **Hide after** times. You don't need to publish again at those times.

## Take the banner down

1. Under **Banner type**, choose **Off**. The preview says "The banner is off, so visitors don't see it." The message and links are kept for next time.
2. Choose **Publish**.

## What visitors see

- The banner shows within a few minutes of publishing.
- It needs JavaScript in the visitor's browser.
- While Project Blue Bridge is on, its own black banner shows instead, and yours is hidden.

## Can't do this?

| Message | What it means |
|---|---|
| "Enter a message, or turn the banner off." | **Banner type** is Information or Emergency, but **Message** is empty. |
| "Keep the message to 300 characters or fewer." | Shorten the message. |
| "Use plain text. Add links below instead of HTML." | The message has < or > in it. Put links in the link boxes. |
| "The end time must be after the start time." | **Hide after** is not later than **Show from**. |
| "Enter the link text." | A link has a web address but no words. |
| "Must start with https:// or / (a page on this site)." | A link's web address is missing, starts with http://, or has a space in it. |
