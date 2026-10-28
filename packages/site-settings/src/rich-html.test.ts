import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bcSettings, prePlan4Settings } from "./fixtures";
import { cleanRichHtml, cleanSettingsHtml, cleanSettingsRichHtml, SETTINGS_RICH_HTML_FIELDS } from "./rich-html";

const NASTY = '<p>Hi<script>alert(1)</script></p><img src="https://x.example/a.png" onerror="alert(2)"><p onclick="x()"><a href="javascript:alert(3)">Click</a></p>';

describe("cleanSettingsHtml", () => {
  it("makes <script>, onerror, onclick and javascript: hrefs inert", () => {
    const out = cleanSettingsHtml(NASTY);
    expect(out).toBe("<p>Hi</p><p>Click</p>");
    for (const bad of ["script", "onerror", "onclick", "javascript:", "<img"]) expect(out).not.toContain(bad);
  });

  it("returns already clean HTML byte-identical, entities, <br /> and newlines included", () => {
    const clean = '<p>Ministry&rsquo;s page&nbsp;<em>FOIPPA</em></p>\n<p>Line<br />\nnext <a href="https://www2.gov.bc.ca/">link</a> <a href="mailto:a@b.ca">mail</a></p>';
    expect(cleanSettingsHtml(clean)).toBe(clean);
    expect(cleanSettingsHtml("<p>A<br>B</p>")).toBe("<p>A<br>B</p>");
    expect(cleanSettingsHtml("")).toBe("");
  });

  it("is the public site's allow-list: output equals cleanRichHtml with images off whenever anything is removed", () => {
    const html = '<p class="visually-hidden" id="x">Kept text</p><img src="/a.png" alt="a"><a href="/\\evil.example">x</a>';
    expect(cleanSettingsHtml(html)).toBe(cleanRichHtml(html, { images: false }));
    expect(cleanSettingsHtml(html)).toBe("<p>Kept text</p>x");
  });

  it("never keeps raw text holding a comment, CDATA, doctype or processing instruction (parsers disagree on those)", () => {
    for (const html of [
      "<p>x</p><![CDATA[><img src=x onerror=alert(1)>]]>",
      "<p>x</p><!--><img src=x onerror=alert(1)>-->",
      "<!DOCTYPE html><p>x</p>",
      "<p>x</p><?x <img src=x onerror=alert(1)> ?>",
    ]) {
      const out = cleanSettingsHtml(html);
      expect(out).toBe(cleanRichHtml(html, { images: false }));
      expect(out).not.toMatch(/<[!?]|onerror|<img/);
    }
  });

  it("is idempotent", () => {
    const once = cleanSettingsHtml(NASTY);
    expect(cleanSettingsHtml(once)).toBe(once);
  });
});

describe("cleanSettingsRichHtml", () => {
  it("leaves the bc settings document untouched (the same object: nothing to clean)", () => {
    const doc = bcSettings();
    expect(cleanSettingsRichHtml(doc)).toBe(doc);
  });

  it("leaves a pre-plan-4 document (no contactsPage or pageText) as it is", () => {
    const doc = prePlan4Settings();
    const out = cleanSettingsRichHtml(doc);
    expect(out).toBe(doc);
    expect("pageText" in out).toBe(false);
  });

  it("cleans every rich field and nothing else", () => {
    const doc = bcSettings();
    doc.contactsPage.introHtml = NASTY;
    doc.pageText.privacy.bodyHtml = NASTY;
    doc.pageText.live.consentHtml = NASTY;
    doc.pageText.live.offAirHtml = NASTY;
    doc.pageText.collectionNotice.bodyHtml = NASTY;
    doc.pageText.subscribeHelpHtml = NASTY;
    doc.pageText.privacy.title = "<b>plain</b>"; // a plain field: validation's job, not cleaning's
    const out = cleanSettingsRichHtml(doc);
    const clean = "<p>Hi</p><p>Click</p>";
    expect(out.contactsPage.introHtml).toBe(clean);
    expect(out.pageText.privacy.bodyHtml).toBe(clean);
    expect(out.pageText.live.consentHtml).toBe(clean);
    expect(out.pageText.live.offAirHtml).toBe(clean);
    expect(out.pageText.collectionNotice.bodyHtml).toBe(clean);
    expect(out.pageText.subscribeHelpHtml).toBe(clean);
    expect(out.pageText.privacy.title).toBe("<b>plain</b>");
    expect(out.banner).toBe(doc.banner);
  });

  it("covers exactly the fields validate.ts checks as rich (plain: false) — a new rich field must be added here", () => {
    const src = readFileSync(new URL("./validate.ts", import.meta.url), "utf8");
    const rich = [...src.matchAll(/checkText\("([^"]+)",[^;]*plain: false/g)].map((m) => m[1]);
    expect(rich.sort()).toEqual([...SETTINGS_RICH_HTML_FIELDS].sort());
  });
});
