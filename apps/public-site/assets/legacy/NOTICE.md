# Vendored legacy assets

These files are copied byte-for-byte from the BC Gov News web app (Apache-2.0, see `LICENSE`),
from the `admin-screens` branch at commit `3fdf3e6` (below), **not from what news.gov.bc.ca serves
today**. Do not edit them; our own changes belong in `assets/site/overrides.css`.

How they compare with live news.gov.bc.ca (checked 2026-10-28, final review of parity plan 1):
- `lib/bootstrap5/css/bootstrap.min.css` is byte-identical to live.
- `Content/site.css` and `Content/custom.css` differ from live only by the admin-screens branch's
  `var(--theme-*, <literal>)` wrappers around colours, plus one `var(--primary-blue, #013366)` in
  site.css's `.granville-bridge-color-off` (live has the bare literals). Each fallback literal is
  live's value (compared case-insensitively with the wrappers stripped), so with no theme
  variable set they render the same.
- Live `custom.css` still has the `--dark: #@d2D2D` typo; the admin-screens copy has it fixed.

So a later diff against live that lands on a colour declaration in these two files is this
source difference, not a vendoring error.

- Source repository: gcpe-news-webapp (BC Gov GCPE News web app; the News-Hub checkout)
- Branch: `admin-screens`
- Commit: `3fdf3e6b6faa92172ba60f8bd2951bce96dbe2de`
- Source root: `Gov.News.WebApp/wwwroot/` (`lib/bootstrap5/css/bootstrap.min.css`, `Content/*.css`, `Content/Images/**` and `favicon.ico` keep their relative paths; the logo and `Gov/` images come from `Content/Images/Gov/`).
- The BC logo SVGs under `Content/Images/Gov/` are committed by owner decision (Q76, 2026-10-28).
- Three non-legacy assets ship beside these files under their own licences:
  - BC Sans (`fonts/BCSans-*.woff2`), copied from the `@bcgov/bc-sans` 2.1.2 npm package by `writeBuiltinAssets` and the build scripts, is under the SIL Open Font License 1.1; its text ships beside the fonts as `fonts/LICENSE_OFL.txt`.
  - hls.js 1.7.3 (Apache-2.0, https://github.com/video-dev/hls.js), its `dist/hls.light.min.js` copied from the `hls.js` npm package by `writeBuiltinAssets` and the build scripts to `assets/vendor/hls.light.min.js`; the /live/ page loads it only when the visitor presses Play in a browser without native HLS.
  - The icon sprite: Font Awesome Free 6.7.2 icons (CC BY 4.0, https://fontawesome.com/license/free), with the attribution comment inside the file, in `assets/site/icons.svg`.
- `Content/legacy.bundle.css` is not in this folder: `writeBuiltinAssets` (apps/public-site/src/site-assets.ts) generates it in the output folder on every start and build. It is `lib/bootstrap5/css/bootstrap.min.css`, `Content/site.css`, `Content/custom.css`, `Content/transforms.css` and `Content/accessibility-styles.css`, byte-for-byte in that order, each followed by a newline, with one leading UTF-8 BOM dropped from each (the one a browser strips from a separate file). It sits in `Content/` so every relative `url()` resolves as it does in the separate files. The files listed below are unchanged.

| File | sha256 |
| --- | --- |
| `Content/Images/Gov/BCID_H_rgb_pos_LH_crop.svg` | 6d3d86a63c1e78a3b07917ef1e8369c336826d8bc3cb417c816cc730dca3c92f |
| `Content/Images/Gov/BCID_H_rgb_pos_LH_crop_bridge.svg` | 33f8e3fcf96805b9ff8966072b5eea2d952ed3d9a1b42f2dd04935a30c39edee |
| `Content/Images/Gov/BC_Mark.svg` | 7ee0f908b42cc4470a6e604af313bda1a56ef5cafd6a29566de79a44ca46543b |
| `Content/Images/Gov/BC_Mark_bridge.svg` | 066f21b0a7f5f06d4099dd28980d55165d80858f69bca477c50f3536fff75c5b |
| `Content/Images/Gov/default-og-image-new.jpg` | 0375219008afedc75b59c7b039677a3b3ae9061f1310818215e234fcda345d98 |
| `Content/Images/Gov/default-og-meta-image-1.jpg` | 2386ad715913ee35b7b09c1b1ef4e2331bb2a8863179585b580ff9e2d25a2707 |
| `Content/Images/Gov/Live_Webcast.png` | 3b23d33f261d8eda323b53933ec59c36c3aefe0058bb2433ffb053d005183086 |
| `Content/Images/Gov/media_background_audio.png` | 51008fe15d7fcea7f73849894f9db77be659ae7eb6025b15608839a745b11d9d |
| `Content/Images/SocialMedia/20x20-white-close.png` | 565150f51c643a87c5309dda9c2fcf00e7c55b813fdf3252e7c3c5bb5851b20c |
| `Content/Images/SocialMedia/32x32-bc-logo.png` | 0d222c488cd8102875871b3f87ae72feccca7c162403cb4047df18f532ec0b5a |
| `Content/Images/SocialMedia/bluesky-logo.svg` | ee3337605c37e2a6ff1ca6498834a27519a214cb243cdc94dc4b040381ad9b3d |
| `Content/Images/SocialMedia/facebook-svg-logo.svg` | 733c64e7407eda8e4fa422b959c86f5b988532be5f2f9f58a4b201315049695b |
| `Content/Images/SocialMedia/flickr-svg-logo.svg` | 843c8345ad265bc8c9ee36b661e5930198d454541b77a0a9dffab63a9ebe4b56 |
| `Content/Images/SocialMedia/Instagram_logo_2016.svg` | 8060ef38a7f4c25ea5e8bf5df005a4472de35f56836c64442341a9e590591e56 |
| `Content/Images/SocialMedia/linkedin-logo-blue.svg` | e1386354342a26e06efba934e63f4d90eeaa456a2bd5ff9b4449b8bed76ce3e3 |
| `Content/Images/SocialMedia/rss-logo.svg` | 44f8bb7a26e0906087651d33df3239f04965f5212eeeed80de8fa60a04c80b7f |
| `Content/Images/SocialMedia/threads_logo.svg` | b4b939d12b58efca4c58655f9d6a819a96c71e6f3d323624997e6fc688e4c175 |
| `Content/Images/SocialMedia/twitter-X-svg-logo.svg` | ad3107d855114d1d82f38a7815a45fce788901a46c513a32836a8a8fb3c3087b |
| `Content/Images/SocialMedia/youtube.svg` | bd7ea4a9ec7643c1f8e80bbb9e91820a3a9fdde54de013944ec0e61d13a7f91d |
| `Content/Images/arrow-down.png` | b605c5f0e9859aaa072acd12c5e28507c776a5488a3d4fe1c2e9295e93eccccf |
| `Content/Images/arrow-left.png` | b94b8e1ece4995beb8e9860f11d2a19b7ecf0a04f72660a7bf87f611d9b2d2c6 |
| `Content/Images/arrow-right.png` | 3203ecd84eedd4553f82138fdbb9cb72988091504e7dc7bd4e1e06578265a46e |
| `Content/Images/arrow-up.png` | d869b81868784a24516126bc71abb7061243f19d491110609398f76d6bb846ea |
| `Content/Images/article-fade.png` | d24f273921052b567b643883fafefece08720d1e2a905d846a3a8e9ce8c68bdd |
| `Content/Images/banner-toggle.svg` | e96d7391938d2f86b0bd5b1d4f48dbf4963e1735269e928538ece570fdf6011a |
| `Content/Images/bg-splitter.png` | 7d6464d62b321e5549e367b9c574de2590a01e3a4a53ee6ad3ab49fd3a4d4352 |
| `Content/Images/chevron-down-search.png` | 36413ad05aeda49aedd73a47055fc0fb6918871997f1e5a40869513836f2c8ff |
| `Content/Images/chevron-down.png` | 0babf02deb31705f9ead002b74ea58006e5c61b349c992ea6b64233c5a521a90 |
| `Content/Images/chevron-up-search.png` | e199dc56928054e87d11ea12b175e8001b56257174539e9b0fbf3f2e4c6b8dea |
| `Content/Images/chevron-up.png` | 26b5a37a8e13fa9b73866ce385f8624ac3d1d82a000e9012bb82e86f4e112ae4 |
| `Content/Images/link-arrow-bl.png` | b8e4a9cc89b6eeb6cc119d790a02baca50934be789126f274a74ad68209d4c80 |
| `Content/Images/link-arrow-wh.png` | e45b8100609911124c2260d2553fa63b1a143c8ef9b2e55a49b3030439876894 |
| `Content/Images/link-out-icon.png` | 7fd00068914d7e236b4418eaa836452414e780562c077fef31042e662764cc20 |
| `Content/Images/media_button_close.png` | 34719b16da2285abfb93a2e1163b2420ff42e02918faf12538adbe1af0114f03 |
| `Content/Images/media_button_play.png` | 0738a493c11a60be570f2c0666d69c97126ec1f3b6ce2d932603049460265998 |
| `Content/Images/media_button_play_alt.png` | affa7c979d92645ef02c1afc00907eeb390bc91f25b75d822de6b4b987283d52 |
| `Content/Images/search-ico.png` | d77bcfc030d7cf3acf262515a60aa3b4ecd43c3f2bcf818e9ec0ca385539eb35 |
| `Content/accessibility-styles.css` | 8f661a9159d6f155b73992a89cfc5be02f4e47fa505ab0cff089eed3a70abc6c |
| `Content/custom.css` | 826edbee6b269a6cae7c63b5922e6d082a0225b537f7cbffd4ed252d17867d49 |
| `Content/granville-bridge-theme.css` | 49030f0f0797849b651012d2498c380989a9d828df8314537b69ffdcc044cf43 |
| `Content/print.css` | 29c91facbed6ede5cf583a8c73bcd54a850ca4e3fabac483c484542d9f885725 |
| `Content/site.css` | 60e013433e9de0f6138e56e051f06d3ac552205df247661dbcd3ecf76b774f1d |
| `Content/transforms.css` | 97297788839a4c2f97e76419cb741380fddbbb4c5798d8b59aaf681bceebc2c3 |
| `favicon.ico` | f4a6580176a7f256faa3a69f3652ca495e0a85fefa330916b49791608b4522ba |
| `lib/bootstrap5/css/bootstrap.min.css` | c7f3ba8472ab6ae9210937a4f21c85cb517576ea1e16539520fdc65e7cbb4e17 |
| `LICENSE` | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 |
