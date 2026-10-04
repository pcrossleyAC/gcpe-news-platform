import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { view } from "@gcpe/nrms-contract/testing";
import { buildRenditionModel, cpDate, mergeLocation } from "./model";
import { renderPdf } from "./pdf";
import { renderText } from "./text";

const TZ = "America/Vancouver";
const opts = { timeZone: TZ, nowMs: Date.parse("2026-10-03T19:00:00Z") };

describe("renditions", () => {
  it("cpDate uses Canadian Press month style in BC time", () => {
    expect(cpDate(new Date("2026-10-03T19:00:00Z"), TZ)).toBe("Oct. 3, 2026");
    expect(cpDate(new Date("2026-05-05T19:00:00Z"), TZ)).toBe("May 5, 2026");
    expect(cpDate(new Date("2026-09-09T19:00:00Z"), TZ)).toBe("Sept. 9, 2026");
    expect(cpDate(new Date("2026-03-01T07:30:00Z"), TZ)).toBe("Feb. 28, 2026");
  });

  it("mergeLocation puts LOCATION – before the first paragraph's text", () => {
    expect(mergeLocation("Victoria", "<p>Clinics open.</p><p>More.</p>")).toBe("<p>VICTORIA – Clinics open.</p><p>More.</p>");
    expect(mergeLocation("Victoria", "<ul><li>a</li></ul><p>b</p>")).toBe("<ul><li>a</li></ul><p>b</p>");
    expect(mergeLocation("", "<p>x</p>")).toBe("<p>x</p>");
  });

  it("reference number rules", () => {
    expect(buildRenditionModel(view(), opts).docs[0]!.referenceNumber).toBe("Not Approved");
    expect(buildRenditionModel(view({ key: "2026HLTH0001-000001", reference: "NEWS-00001" }), opts).docs[0]!.referenceNumber).toBe("2026HLTH0001-000001");
    expect(buildRenditionModel(view({ type: "story", key: "story", reference: "NEWS-00002" }), opts).docs[0]!.referenceNumber).toBe("NEWS-00002");
    expect(buildRenditionModel(view({ type: "advisory", reference: "NEWS-00003" }), opts).docs[0]!.referenceNumber).toBeNull();
  });

  it("text version follows the legacy layout", () => {
    const v = view({ key: "2026HLTH0001-000001", reference: "NEWS-00001", releasedAt: "2026-10-03T19:00:00Z" });
    expect(renderText(v, opts)).toBe(
      [
        "For Immediate Release", "2026HLTH0001-000001", "Oct. 3, 2026", "", "Ministry of Health", "",
        "NEWS RELEASE", "Clinics open", "", "VICTORIA - Body", "", "Contact:", "", "Media Relations", "250-555-0100",
        "", "", "Connect with the Province of B.C. at: http://news.gov.bc.ca/connect",
      ].join("\r\n"),
    );
  });

  it("bilingual text adds the French note and French contact heading", () => {
    const v = view({
      documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
        { languageId: 4105, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: ["Media"] },
        { languageId: 3084, pageTitle: "Communiqué", headline: "Cliniques", subheadline: null, organizations: "Ministère", byline: null, bodyHtml: "<p>Corps</p>", pageImageId: null, contacts: ["Médias"] },
      ] }],
    });
    const t = renderText(v, opts);
    expect(t).toContain("(disponible en français en bas de page)");
    expect(t).toContain("Renseignements additionnels:");
    expect(t.indexOf("CLINICS")).toBeLessThan(0); // page titles are upper-cased, headlines are not
    expect(t.indexOf("NEWS RELEASE")).toBeLessThan(t.indexOf("COMMUNIQUÉ"));
  });

  it("PDF is a valid document titled with the headline, and tolerates unencodable characters", async () => {
    const pdf = await renderPdf(view({ documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [
      { languageId: 4105, pageTitle: "News Release", headline: "Clinics open 中文", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: `<p>${"Long paragraph. ".repeat(400)}</p>`, pageImageId: null, contacts: ["Media"] },
    ] }] }), opts);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Clinics open 中文");
  });

  it("mergeLocation skips a leading <asset>, keeps entities as written, and escapes the location", () => {
    expect(mergeLocation("Prince George & Area", '<p><asset>https://youtu.be/x</asset>A &amp; B&nbsp;c</p>')).toBe(
      "<p><asset>https://youtu.be/x</asset>PRINCE GEORGE &amp; AREA – A &amp; B&nbsp;c</p>",
    );
    expect(mergeLocation("V", "<p></p><ul><li>&nbsp;</li></ul><p>b</p>")).toBe("<p></p><ul><li>&nbsp;</li></ul><p>V – b</p>");
  });

  it("informal layout prefixes the byline; an advisory shows its page title only and no reference", () => {
    const v = view({ type: "advisory", reference: "NEWS-00003", documents: [{ id: "d1", sortIndex: 0, layout: "informal", languages: [
      { languageId: 4105, pageTitle: "Media Advisory", headline: "Minister visits", subheadline: "Line one\nLine two", organizations: "Ministry of Health", byline: "By Pat\nWriter", bodyHtml: "<p>Body <asset>https://youtu.be/x</asset></p><p>&nbsp;</p>", pageImageId: null, contacts: ["A\nB", "C"] },
    ] }] });
    const m = buildRenditionModel(v, opts);
    expect(m.docs[0]!.bodyHtml).toBe("&nbsp;<br /><b>By Pat<br />Writer</b><br /><br /><br /><br /><p>VICTORIA – Body </p>");
    expect(m.docs[0]!.subheadlineLines).toEqual(["Line one", "Line two"]);
    const t = renderText(v, opts);
    expect(t.startsWith("For Immediate Release\r\n\r\nOct. 3, 2026\r\n")).toBe(true);
    expect(t).toContain("\r\nMEDIA ADVISORY\r\nLine one\r\nLine two\r\n");
    expect(t).not.toContain("Minister visits");
    expect(t).toContain("By Pat\r\nWriter\r\n\r\nVICTORIA - Body");
    expect(t).toContain("Contacts:\r\n\r\nA\r\nB\r\n\r\nC\r\n");
  });

  it("documents run English first, then French, each by sortIndex; French falls back to the English location", () => {
    const lang = (languageId: 4105 | 3084, headline: string) => ({ languageId, pageTitle: "T", headline, subheadline: null, organizations: null, byline: null, bodyHtml: "<p>x</p>", pageImageId: null, contacts: [] });
    const m = buildRenditionModel(view({ documents: [
      { id: "b", sortIndex: 1, layout: "formal", languages: [lang(4105, "en-b"), lang(3084, "fr-b")] },
      { id: "a", sortIndex: 0, layout: "formal", languages: [lang(4105, "en-a"), lang(3084, "fr-a")] },
    ] }), opts);
    expect(m.docs.map((d) => d.headline)).toEqual(["en-a", "en-b", "fr-a", "fr-b"]);
    expect(m.docs.map((d) => d.bodyHtml)).toEqual(["<p>VICTORIA – x</p>", "<p>x</p>", "<p>VICTORIA – x</p>", "<p>x</p>"]);
    expect(m.releaseDate).toBe("Oct. 3, 2026");
  });

  it("PDF draws the page image when one is given", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const withImage = await renderPdf(view(), { ...opts, pageImage: { bytes: png, mimeType: "image/png" } });
    const without = await renderPdf(view(), opts);
    expect(withImage.toString("latin1")).toContain("/Subtype /Image");
    expect(without.toString("latin1")).not.toContain("/Subtype /Image");
    expect((await PDFDocument.load(without)).getTitle()).toBe("Clinics open");
  });
});
