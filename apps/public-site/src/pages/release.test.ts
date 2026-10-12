import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { post, site } from "../../test/fixtures";
import { renderReleasePage } from "./release";

const ctx = { ministryNames: new Map([["health", "Health"]]), related: [{ key: "K2", headline: "Other <news>", publishDate: "2026-10-01T09:00:00-07:00" }] };

describe("release page", () => {
  it("is accessible: one h1 (the headline), escaped, with the trusted body", () => {
    const html = renderReleasePage(post({ documents: [{ languageId: 4105, headline: "Clinics <script>x</script>", subheadline: "Sub & more", detailsHtml: "<p>Body.</p>", contacts: [] }] }), site, {}, ctx);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("h1")?.textContent).toBe("Clinics <script>x</script>");
    expect(html).not.toContain("<script>x</script>");
    expect(doc.querySelector("main p.subheadline")?.textContent).toBe("Sub & more");
    expect(html).toContain("<p>Body.</p>");
  });

  it("demotes body headings so the page keeps one h1", () => {
    const html = renderReleasePage(post({ documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: "<H1 class=\"x\">Inner</H1><h2>Two</h2><h6>Six</h6>", contacts: [] }] }), site, {}, ctx);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(html).toContain('<h2 class="x">Inner</h2>');
    expect(html).toContain("<h3>Two</h3>");
    expect(html).toContain("<h6>Six</h6>");
  });

  it("shows the date, location, ministry link, contacts, assets, translations and related posts", () => {
    const doc = expectAccessibleStructure(renderReleasePage(post({}), site, {}, ctx));
    expect(doc.querySelector("main time")?.getAttribute("datetime")).toBe("2026-10-03T10:00:00-07:00");
    expect(doc.querySelector("main time")?.textContent).toBe("October 3, 2026");
    expect(doc.querySelector('a[href="/ministries/health/"]')?.textContent).toBe("Health");
    const img = doc.querySelector("figure img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(doc.querySelector("figure figcaption")?.textContent).toBe("Clinic <photo>");
    expect(doc.querySelector('a[href="https://files.example/files/doc.pdf"]')?.textContent).toContain("PDF");
    expect(doc.querySelector('a[href="https://files.example/files/fr.pdf"]')?.textContent).toContain("Français");
    expect([...doc.querySelectorAll("section h2")].map((h) => h.textContent)).toEqual(["Contacts", "Media assets", "Translations", "Related news"]);
    expect(doc.querySelector('a[href="/releases/K2/"]')?.textContent).toBe("Other <news>");
  });

  it("leaves out empty sections and an unknown ministry", () => {
    const doc = expectAccessibleStructure(renderReleasePage(post({ ministryKeys: ["nope"], azureAssets: null, azureTranslations: null, documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: null, contacts: [] }] }), site, {}, { ministryNames: new Map(), related: [] }));
    expect(doc.querySelectorAll("section")).toHaveLength(0);
    expect(doc.querySelector('main a[href^="/ministries/"]')).toBeNull();
  });

  it("refuses a javascript: asset/translation URL instead of rendering it as a link or image", () => {
    const html = renderReleasePage(
      post({
        azureAssets: [
          { key: "javascript:alert(1)", label: "Evil doc", length: 10 },
          { key: "javascript:alert(1)//a.png", label: "Evil photo", length: 10 },
        ],
        azureTranslations: [{ key: "javascript:alert(1)", label: "Évil", length: 10 }],
      }),
      site,
      {},
      ctx,
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
    expect(html).not.toContain("Evil doc");
    expect(html).not.toContain("Evil photo");
    expect(html).not.toContain("Évil");
  });

  it("escapes every interpolated field (asset labels, contacts, location)", () => {
    const html = renderReleasePage(post({ location: "A & <B>", documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: null, contacts: [{ title: "<b>T</b>", details: "x\n<y>" }] }] }), site, {}, ctx);
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).toContain("x<br>&lt;y&gt;");
    expect(html).toContain("Clinic &lt;photo&gt;");
  });
});
