/**
 * The icon ids the chrome uses, each mapped to its Font Awesome Free 6.7.2 source
 * (`@fortawesome/fontawesome-free/svgs/<path>.svg`). `scripts/build-icons.ts` turns them into
 * `assets/site/icons.svg`, one `<symbol id="i-<id>">` each; only that sprite ships, never the
 * Font Awesome CSS or fonts.
 */
export const ICONS = {
  search: "solid/magnifying-glass",
  xmark: "solid/xmark",
  "angle-down": "solid/angle-down",
  "angle-up": "solid/angle-up",
  bars: "solid/bars",
  "caret-right": "solid/caret-right",
  download: "solid/download",
  language: "solid/language",
  print: "solid/print",
  "circle-info": "solid/circle-info",
  "circle-exclamation": "solid/circle-exclamation",
  envelope: "solid/envelope",
  rss: "solid/rss",
  blog: "solid/blog",
  facebook: "brands/facebook",
  "square-facebook": "brands/square-facebook",
  "x-twitter": "brands/x-twitter",
  "square-x-twitter": "brands/square-x-twitter",
  instagram: "brands/instagram",
  threads: "brands/threads",
  "square-threads": "brands/square-threads",
  bluesky: "brands/bluesky",
  "square-bluesky": "brands/square-bluesky",
  linkedin: "brands/linkedin",
  flickr: "brands/flickr",
  youtube: "brands/youtube",
  weibo: "brands/weibo",
} as const satisfies Record<string, string>;

export type IconId = keyof typeof ICONS;

/** An inline `<svg>` that references one symbol of the sprite; decorative, so hidden from assistive tech. */
export function icon(id: IconId, base: string, cls = "icon"): string {
  return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="${base}/assets/site/icons.svg#i-${id}"></use></svg>`;
}
