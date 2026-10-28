import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { sanitizeBodyHtml } from "../sanitize-body";
import { leadMedia, renderBodyAssets, renderMedia } from "./media";

const frag = (html: string) => JSDOM.fragment(html);
const PLACEHOLDER = "/site/assets/legacy/Content/Images/Gov/default-og-meta-image-1.jpg";

describe("leadMedia", () => {
  it("leadMedia: live.staticflickr.com jpg → image with the bcgovphotos page; youtu.be/x and youtube.com/watch?v=x → youtube; news.gov.bc.ca/live → live; flickr.com page, javascript:, '' → null", () => {
    expect(leadMedia("https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e_b.jpg")).toEqual({
      kind: "image",
      src: "https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e_b.jpg",
      href: "https://www.flickr.com/photos/bcgovphotos/53912345678/",
    });
    expect(leadMedia("https://youtu.be/abcdef1")).toEqual({ kind: "youtube", id: "abcdef1", href: "https://www.youtube.com/watch?v=abcdef1" });
    expect(leadMedia("https://www.youtube.com/watch?v=abcdef1")).toEqual({ kind: "youtube", id: "abcdef1", href: "https://www.youtube.com/watch?v=abcdef1" });
    expect(leadMedia("https://news.gov.bc.ca/live")).toEqual({ kind: "live", href: "https://news.gov.bc.ca/live" });
    expect(leadMedia("https://news.gov.bc.ca/live/")).toEqual({ kind: "live", href: "https://news.gov.bc.ca/live/" });
    expect(leadMedia("https://www.flickr.com/photos/bcgovphotos/53912345678/")).toBeNull();
    expect(leadMedia("javascript:alert(1)")).toBeNull();
    expect(leadMedia("")).toBeNull();
    expect(leadMedia(null)).toBeNull();
    expect(leadMedia(undefined)).toBeNull();
  });

  it("upgrades an http farm URL to https; a size suffix is optional", () => {
    expect(leadMedia("http://farm8.staticflickr.com/7400/27012345678_abcdef0123.jpg")).toEqual({
      kind: "image",
      src: "https://farm8.staticflickr.com/7400/27012345678_abcdef0123.jpg",
      href: "https://www.flickr.com/photos/bcgovphotos/27012345678/",
    });
  });

  it("refuses look-alikes: another host ending in staticflickr.com, a non-jpg, trailing junk, a bad YouTube id", () => {
    expect(leadMedia("https://live.staticflickr.com.evil.example/65535/1_ab.jpg")).toBeNull();
    expect(leadMedia("https://evil.staticflickr.com/65535/1_ab.jpg")).toBeNull();
    expect(leadMedia("https://live.staticflickr.com/65535/1_ab.png")).toBeNull();
    expect(leadMedia('https://live.staticflickr.com/65535/1_ab.jpg"onerror=x')).toBeNull();
    expect(leadMedia("https://www.youtube.com/watch?v=abc")).toBeNull(); // shorter than 6
    expect(leadMedia("https://www.youtube.com/watch?v=abcdef1%22%3E")).toBeNull();
    expect(leadMedia("https://youtu.be/abc<def>")).toBeNull();
    expect(leadMedia("https://www.youtube.com.evil.example/watch?v=abcdef1")).toBeNull();
    expect(leadMedia("https://news.gov.bc.ca/live/now")).toBeNull();
  });
});

describe("renderMedia", () => {
  it("renderMedia youtube never references youtube.com in a src; image keeps https src and escapes alt", () => {
    const yt = renderMedia({ kind: "youtube", id: "abcdef1", href: "https://www.youtube.com/watch?v=abcdef1" }, "/site", 'A "quoted" <headline>');
    const ytDoc = frag(yt);
    expect(ytDoc.querySelector("div.asset.youtube > a")?.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abcdef1");
    for (const el of ytDoc.querySelectorAll("[src]")) expect(el.getAttribute("src")).not.toMatch(/youtube|ytimg/);
    expect(ytDoc.querySelector("img")?.getAttribute("src")).toBe(PLACEHOLDER);
    expect(ytDoc.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(ytDoc.querySelector("a")?.textContent).toBe('Watch on YouTube: A "quoted" <headline>');
    expect(ytDoc.querySelector("span.visually-hidden")?.textContent).toBe(': A "quoted" <headline>');
    expect(yt).not.toContain("<headline>");

    const img = renderMedia({ kind: "image", src: "https://live.staticflickr.com/65535/1_ab.jpg", href: "https://www.flickr.com/photos/bcgovphotos/1/" }, "/site", 'Tom & "Jerry" <b>');
    expect(img).toBe('<div class="asset flickr"><a href="https://www.flickr.com/photos/bcgovphotos/1/"><img src="https://live.staticflickr.com/65535/1_ab.jpg" alt="Tom &amp; &quot;Jerry&quot; &lt;b&gt;"></a></div>');
  });

  it("live is a plain link to the webcast", () => {
    expect(renderMedia({ kind: "live", href: "https://news.gov.bc.ca/live" }, "", "x")).toBe('<p><a href="https://news.gov.bc.ca/live">Watch the live webcast</a></p>');
  });
});

describe("renderBodyAssets", () => {
  it("renderBodyAssets: '<asset>https://www.youtube.com/watch?v=abcdef1&amp;t=2</asset>' → div.asset.youtube; soundcloud → plain link; '<asset>javascript:alert(1)</asset>' → removed", () => {
    const yt = frag(renderBodyAssets("<p>Before</p><asset>https://www.youtube.com/watch?v=abcdef1&amp;t=2</asset><p>After</p>", "/site"));
    expect(yt.querySelector("div.asset.youtube > a")?.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abcdef1");
    expect(yt.querySelector("div.asset.youtube img")?.getAttribute("src")).toBe(PLACEHOLDER);
    expect([...yt.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Before", "After"]);
    expect(yt.querySelector("asset")).toBeNull();

    const sc = renderBodyAssets("<asset>https://soundcloud.com/bcgov/clip?a=1&amp;b=2</asset>", "/site");
    expect(sc).toBe('<p><a href="https://soundcloud.com/bcgov/clip?a=1&amp;b=2">https://soundcloud.com/bcgov/clip?a=1&amp;b=2</a></p>');

    expect(renderBodyAssets("<p>A</p><asset>javascript:alert(1)</asset><p>B</p>", "/site")).toBe("<p>A</p><p>B</p>");
  });

  it("a Flickr asset becomes the image embed with alt=''; the live URL the webcast link; several in one body; case and whitespace tolerated", () => {
    const html = renderBodyAssets("<ASSET> https://live.staticflickr.com/65535/42_ab.jpg </ASSET>\n<asset>https://news.gov.bc.ca/live</asset>", "");
    expect(html).toBe(
      '<div class="asset flickr"><a href="https://www.flickr.com/photos/bcgovphotos/42/"><img src="https://live.staticflickr.com/65535/42_ab.jpg" alt=""></a></div>\n<p><a href="https://news.gov.bc.ca/live">Watch the live webcast</a></p>',
    );
  });

  it("removes an unparseable, relative, protocol-relative, data: or entity-smuggled javascript: URL, and an empty asset", () => {
    for (const bad of ["not a url", "/files/x.mp3", "//evil.example/x", "data:text/html,x", "&#106;avascript:alert(1)", "jav&#x61;script:alert(1)", "", "https://ok.example/\\x"]) {
      expect(renderBodyAssets(`<p>A</p><asset>${bad}</asset>`, "/site"), bad).toBe("<p>A</p>");
    }
  });

  it("escapes a decoded URL that carries markup, so it cannot break out of the attribute", () => {
    const out = renderBodyAssets('<asset>https://ok.example/?q=&quot;&gt;&lt;script&gt;</asset>', "");
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/href="[^"]*"[^>]*"/);
    expect(frag(out).querySelector("a")?.getAttribute("href")).toBe('https://ok.example/?q="><script>');
  });

  it("every embed survives sanitizeBodyHtml unchanged (bar its self-closing img style)", () => {
    const body = renderBodyAssets("<p>x</p><asset>https://youtu.be/abcdef1</asset><asset>https://live.staticflickr.com/1/2_ab.jpg</asset><asset>https://soundcloud.com/a?b=1&amp;c=2</asset>", "/site");
    expect(sanitizeBodyHtml(body).replace(/ \/>/g, ">")).toBe(body);
  });

  it("leaves a body with no asset untouched", () => {
    const body = "<p>Tom &amp; Jerry</p>";
    expect(renderBodyAssets(body, "/site")).toBe(body);
  });
});
