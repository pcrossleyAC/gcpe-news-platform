import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, site } from "../../test/fixtures";
import { renderLivePage } from "./live";

const STREAM = "https://stream.example.gov.bc.ca/live/playlist.m3u8";
const text = (over: Partial<ReturnType<typeof bcSettings>["pageText"]["live"]> = {}) => ({ ...bcSettings().pageText.live, ...over });
const render = (stream: string | null = STREAM, t = text()) => expectAccessibleStructure(renderLivePage(stream, t, site, { settings: bcSettings() }));

describe("live page (/live/)", () => {
  it("live: one h1, the placeholder with alt='', a play button described by the consent text with {host} replaced, video preload=none hidden, stream link", () => {
    const doc = render();
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Live"]);
    const root = doc.querySelector("main div.connect > div.home-body#main-content-release")!;
    expect(root.querySelector("h1.page-label")).not.toBeNull();
    const wrap = root.querySelector("div#body.container.live-body > div.wowza-wrapper.asset.wowza.video")!;
    expect(wrap.getAttribute("data-stream")).toBe(STREAM);
    const img = wrap.querySelector("div.placeholder-container > img")!;
    expect(img.getAttribute("src")).toBe("/assets/legacy/Content/Images/Gov/Live_Webcast.png");
    expect(img.getAttribute("alt")).toBe("");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["768", "432"]);
    const inner = wrap.querySelector("div.placeholder-container > div.overlay-container > div.outer > div.inner")!;
    const btn = inner.querySelector("button.play-button")!;
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-describedby")).toBe("live-consent");
    expect(btn.textContent).toBe("Play the live webcast");
    const consent = inner.querySelector("div#live-consent.play-instructions.preface")!;
    expect(consent.textContent).toContain("stream.example.gov.bc.ca");
    expect(consent.textContent).not.toContain("{host}");
    expect(consent.querySelector("strong")?.textContent).toBe("stream.example.gov.bc.ca");
    const video = wrap.querySelector("video")!;
    expect(video.hasAttribute("controls") && video.hasAttribute("playsinline") && video.hasAttribute("hidden")).toBe(true);
    expect(video.getAttribute("preload")).toBe("none");
    expect(video.hasAttribute("src")).toBe(false);
    expect(wrap.querySelector("p#live-status")?.getAttribute("role")).toBe("status");
    const link = wrap.querySelector("p.live-stream-link > a")!;
    expect(link.getAttribute("href")).toBe(STREAM);
    expect(link.textContent).toBe("Open the stream in your media player");
  });

  it("the play button's name is visually hidden text, not an aria-label that differs from it", () => {
    const btn = render().querySelector("button.play-button")!;
    expect(btn.querySelector("span.visually-hidden")?.textContent).toBe("Play the live webcast");
    expect(btn.hasAttribute("aria-label")).toBe(false);
  });

  it("the stream URL is escaped where it is written (data-stream and the link)", () => {
    const html = renderLivePage('https://a.example/x?q="><b>', text(), site, {});
    expect(html).not.toContain('"><b>');
    expect(html).toContain("&quot;&gt;&lt;b&gt;");
  });

  it("{host} substitution is literal: $&, $`, $' in a host cannot expand or break out of an attribute", () => {
    const consent = `<p>Streamed from <a href="https://{host}/">{host}</a></p>`;
    for (const host of ["a$&b.example", "a$`b.example", "a$'b.example", "x$`onmouseover=window.pwned=1;\".example"]) {
      const html = renderLivePage(`https://${host}/live.m3u8`, text({ consentHtml: consent }), site, {});
      expect(html, host).not.toMatch(/onmouseover|\$&|\$`/);
      expect(html, host).not.toContain("data-stream");
    }
  });

  it("a userinfo URL or a host with markup characters is off air", () => {
    for (const bad of ["https://user:pw@stream.example/x.m3u8", "https://user@stream.example/x.m3u8", "https://x$`onmouseover=window.pwned=1;\".example/live.m3u8"]) {
      const html = renderLivePage(bad, text(), site, {});
      expect(html, bad).not.toMatch(/data-stream|<video|play-button/);
    }
    expect(renderLivePage("https://xn--bcher-kva.example:8443/x.m3u8", text(), site, {})).toContain("data-stream");
  });

  it("plain-text settings are not an attack surface: the heading is escaped", () => {
    const html = renderLivePage(STREAM, text({ heading: "<b>Live</b>" }), site, {});
    expect(html).toContain("&lt;b&gt;Live&lt;/b&gt;");
    expect(html).not.toContain("<b>Live</b>");
  });

  it("off air: the off-air text, no video, no data-stream", () => {
    const doc = render(null);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const wrap = doc.querySelector("div#body.live-body > div.wowza-wrapper.asset.video.off-air")!;
    expect(wrap.textContent).toContain("There is no live webcast right now.");
    expect(wrap.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(doc.querySelector("video, button.play-button, [data-stream], #live-status, .live-stream-link")).toBeNull();
    expect(doc.querySelector(".wowza-wrapper.wowza")).toBeNull();
  });

  it("no src or data-stream ever holds a non-https URL (http:, javascript:)", () => {
    for (const bad of ["http://stream.example/x.m3u8", "javascript:alert(1)", "//stream.example/x.m3u8", "/x.m3u8", ""]) {
      const html = renderLivePage(bad, text(), site, {});
      expect(html, bad).not.toMatch(/data-stream|<video|play-button/);
      if (bad) expect(html, bad).not.toContain(`"${bad}"`);
    }
  });

  it("consentHtml and offAirHtml with <script>, onclick or images render without them", () => {
    const evil = `<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a></p><script>alert(1)</script><img src=x onerror="alert(1)"><iframe src="https://evil.example"></iframe>`;
    for (const stream of [STREAM, null]) {
      const doc = render(stream, text({ consentHtml: evil, offAirHtml: evil }));
      const scope = doc.querySelector("#body")!;
      expect(scope.querySelector("script, iframe, img[src='x']")).toBeNull();
      expect(scope.innerHTML).not.toMatch(/onclick|onerror|javascript:/i);
      expect(scope.querySelectorAll("img").length).toBe(1); // only the placeholder
    }
  });

  it("{host} is replaced in every occurrence, after sanitising", () => {
    const doc = render(STREAM, text({ consentHtml: "<p>{host} and {host}</p>" }));
    expect(doc.querySelector("#live-consent")!.textContent).toBe("stream.example.gov.bc.ca and stream.example.gov.bc.ca");
  });
});
