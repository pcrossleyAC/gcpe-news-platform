---
id: hub-address-check
title: Hub address check
manual: nrms-site-editor
order: 55
routes: [/website/address-check]
screens: [website]
topics: []
---
**Who this is for:** Site editors (NRMS.SiteEditor).

**Website** > **Hub address check** lists every web address saved on the Website screens that points at the Hub itself. Staff can open such an address, but the public can't: visitors get a broken link or image. Use it before the site goes live, and whenever you want to check.

## What it checks

- **Carousel**: the live and next carousels' slides.
- **Emergency pins**: both pins.
- **Live Feed**: its two addresses.
- **Resource links**.
- **Site settings**: what is published now, on every settings screen.

Drafts that nobody has published, and past carousels, aren't on the public site, so they aren't checked. Release text isn't checked either.

## Fix what it lists

Each screen with an address to fix has its own heading, the addresses under it, and where on the screen each one is (such as "Live carousel, slide 2: action URL", or the link's text on a settings screen).

1. Choose **Open** and the screen's name, such as **Open Carousel**.
2. Find the address and replace it. For a file, open [Files](manual:website-files), choose **Copy public address** beside the file, and paste that instead.
3. Save, or publish the settings, as you normally do on that screen.
4. Come back to **Hub address check**. Once the change is live, the address is no longer listed.

When nothing is left, the page says "Nothing saved on the Website points at the Hub."

The page only lists addresses; it never changes them.

## Which addresses count

An address counts when it is on any of the Hub's own web addresses: the one in your browser's address bar, and the others the Hub's server is known by. An address on the public site, such as one copied with **Copy public address**, never counts. If an address you know points at the Hub isn't listed, ask the people who run the servers to add that name to the Hub's settings.
