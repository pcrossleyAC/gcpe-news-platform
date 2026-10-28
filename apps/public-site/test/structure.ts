import { JSDOM } from "jsdom";
import { expect } from "vitest";
import { SITE_BANNER_SCRIPT } from "../src/banner-script";
import { HTML_JS_MARKER } from "../src/render";

/** A page without the chrome's two inline scripts (the head's html.js marker and the site
 * banner's script, banner-script.ts; both on every page), for a test asserting that the page's
 * *own* content carries no script — exactly those constants are removed, nothing else. */
export const withoutBannerScript = (html: string): string =>
  html.replace(`<script>${HTML_JS_MARKER}</script>`, "").replace(`<script>${SITE_BANNER_SCRIPT}</script>`, "");

/**
 * The structural half of WCAG 2.2 AA that a static check can prove (spec §6.3): language,
 * one h1, a skip link to #main as the first focusable element, the four landmarks, alt on
 * every image, no positive tabindex, a non-empty title. axe-core and Lighthouse run in 6e.
 */
export function expectAccessibleStructure(html: string): Document {
  const { document } = new JSDOM(html).window;
  expect(document.documentElement.getAttribute("lang")).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
  expect(document.title.trim()).not.toBe("");
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  for (const tag of ["header", "main", "footer"]) expect(document.querySelectorAll(tag), tag).toHaveLength(1);
  // More than one nav is allowed (e.g. pagination), but each needs its own label.
  expect(document.querySelectorAll("header nav")).toHaveLength(1);
  for (const nav of document.querySelectorAll("nav")) expect(nav.getAttribute("aria-label"), nav.outerHTML.slice(0, 80)).toBeTruthy();
  const main = document.querySelector("main")!;
  expect(main.id).toBe("main");
  const firstFocusable = document.querySelector("a[href], button, input, select, textarea, [tabindex]");
  expect(firstFocusable?.getAttribute("href")).toBe("#main");
  for (const img of document.querySelectorAll("img")) expect(img.hasAttribute("alt"), img.outerHTML).toBe(true);
  for (const el of document.querySelectorAll("[tabindex]")) expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
  return document;
}
