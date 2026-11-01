---
id: live-feed
title: Live Feed
manual: nrms-site-editor
order: 30
routes: [/website/live-feed]
screens: [website]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Live Feed** controls the public site's **Live Webcast** button, which plays a live stream such as a news conference.

- **M3U URL** is the address of the stream itself. It is needed to turn the feed on.
- **Manifest URL** is optional. The public site doesn't use it.

Both addresses come from whoever runs the webcast. Choose **?** beside a field for a short explanation.

## Turn the Live Feed on

1. Enter the **M3U URL**, and the **Manifest URL** if you have one.
2. Switch **Live Feed on** on.
3. Choose **Save Live Feed**. You see "Saved at 2:30 PM. Live now: the Live Webcast button shows on the public site within a few minutes." (with the time).

The **Live Webcast** button shows on every page while **Live Feed on** is switched on. Pages that are already open pick up the change within a minute. Turn the feed off when the webcast ends.

The wording around the webcast, such as the button's label and the text shown when nothing is live, is on [Navigation and labels](manual:footer-and-navigation) and [Page text](manual:page-text).

## Turn the Live Feed off

1. Switch **Live Feed on** off.
2. Choose **Save Live Feed**. You see "Saved at 2:30 PM. The Live Feed is off: the Live Webcast button goes from the public site within a few minutes."

## What happens next

- The button shows or goes within a few minutes.
- **Website log** lists "Turned the Live Feed on", "Turned the Live Feed off" or "Changed the Live Feed URLs", with your name.

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "Add the M3U playlist URL before turning the Live Feed on." | Enter the **M3U URL** first. |
| "Live Feed URLs must be https:// or empty." | Both addresses must start with https://. |
| "Someone else changed this — reload to see their changes." | Another site editor saved the Live Feed while you had the page open. Choose **Reload**. |
