import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, site } from "../../test/fixtures";
import { renderPrivacyPage } from "./privacy";

const text = (over: Partial<ReturnType<typeof bcSettings>["pageText"]["privacy"]> = {}) => ({ ...bcSettings().pageText.privacy, ...over });
const render = (p = text()) => expectAccessibleStructure(renderPrivacyPage(p, site, { settings: bcSettings() }));

describe("privacy page (/privacy/)", () => {
  it("one h1 (title); label paragraph; body paragraphs kept with their links", () => {
    const doc = render();
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["B.C. Government Website Privacy Statement"]);
    const root = doc.querySelector("main div.connect > div.home-body#main-content-release")!;
    expect(root.querySelector("p.page-label")?.textContent).toBe("Privacy");
    expect(root.querySelector("h1")).not.toBeNull();
    const body = root.querySelector("div#body")!;
    expect(body.querySelectorAll("p").length).toBeGreaterThan(3);
    expect(body.textContent).toContain("(250) 356-1851");
    expect(doc.body.textContent).not.toMatch(/Reset Preferences/);
  });

  it("bodyHtml with <h1>, <script>, <iframe>, <img onerror> -> still one h1, none of the others", () => {
    const doc = render(text({ bodyHtml: `<h1>Inner</h1><p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://gov.example/ok">ok</a></p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror="alert(1)">` }));
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const body = doc.querySelector("#body")!;
    expect(body.querySelector("h2")?.textContent).toBe("Inner");
    expect(body.querySelector("script, iframe, img")).toBeNull();
    expect(body.innerHTML).not.toMatch(/onclick|onerror|javascript:/i);
    expect(body.querySelector('a[href="https://gov.example/ok"]')).not.toBeNull();
  });

  it("title and label are escaped; empty label and body do not crash", () => {
    const html = renderPrivacyPage(text({ title: "<b>T</b>", label: "", bodyHtml: "" }), site, {});
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).not.toContain("<b>T</b>");
    expect(html).not.toContain('class="page-label"');
  });
});
