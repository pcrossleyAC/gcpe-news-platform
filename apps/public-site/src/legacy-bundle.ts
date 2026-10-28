/**
 * The legacy stylesheets every page blocks rendering on, in legacy order, concatenated into one
 * generated file so a page makes one request instead of five. The sources stay unmodified (P3).
 * The bundle sits in Content/ beside site.css so the relative url()s in site.css and
 * custom.css ("../fonts/…") and transforms.css ("Images/…") resolve exactly as before;
 * bootstrap.min.css has only data: urls. print.css (media=print) and granville-bridge-theme.css
 * (Blue Bridge only) stay separate.
 *
 * A pure module (no Node I/O), so the renderer can name the bundle without importing the code
 * that writes it (site-assets.ts).
 */
export const LEGACY_BUNDLE = "legacy/Content/legacy.bundle.css";
export const LEGACY_BUNDLE_SOURCES = [
  "legacy/lib/bootstrap5/css/bootstrap.min.css",
  "legacy/Content/site.css",
  "legacy/Content/custom.css",
  "legacy/Content/transforms.css",
  "legacy/Content/accessibility-styles.css",
] as const;
