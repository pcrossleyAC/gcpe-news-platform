import { describe, expect, it } from "vitest";
import { renderFeedXml } from "@gcpe/emergency-feed-fake";
import { FeedFormatError, htmlToText, MAX_ALERT_TEXT, MAX_TITLE_LENGTH, normalizeLinkIdentity, parseEmergencyFeed } from "./feed";

/** The shape of a WordPress category feed (legacy's production feed was one). */
const WORDPRESS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Alerts &#8211; Emergency Info BC</title>
  <atom:link href="https://emergency.example.test/category/alerts/feed/" rel="self" type="application/rss+xml" />
  <item>
    <title>Evacuation order &#8211; Sample Creek&#8217;s east bank</title>
    <link>https://emergency.example.test/alerts/sample-creek/</link>
    <pubDate>Tue, 06 Oct 2026 21:15:00 +0000</pubDate>
    <guid isPermaLink="false">https://emergency.example.test/?p=1234</guid>
    <description><![CDATA[Short excerpt]]></description>
    <content:encoded><![CDATA[<p>Leave&nbsp;now.</p><ul><li>Route: Highway 1</li><li>Shelter: <a href="https://emergency.example.test/shelters">reception centre</a></li></ul><script>alert(1)</script><p>More at the <a href="https://emergency.example.test/">site</a>.</p>]]></content:encoded>
  </item>
</channel>
</rss>`;

describe("parseEmergencyFeed", () => {
  it("reads a WordPress RSS item: guid, link, decoded title, full content as text, date", () => {
    const { alerts, skipped } = parseEmergencyFeed(WORDPRESS);
    expect(skipped).toBe(0);
    expect(alerts).toEqual([
      {
        identity: "https://emergency.example.test/?p=1234",
        link: "https://emergency.example.test/alerts/sample-creek/",
        title: "Evacuation order – Sample Creek’s east bank",
        text: "Leave now.\n\n- Route: Highway 1\n- Shelter: reception centre (https://emergency.example.test/shelters)\n\nMore at the site (https://emergency.example.test/).",
        publishedAt: new Date("2026-10-06T21:15:00Z"),
      },
    ]);
  });

  it("falls back to description, and to the link when there is no guid", () => {
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts[0]).toMatchObject({ identity: "https://emergency.example.test/a", text: "Body", publishedAt: null });
  });

  it("reads Atom entries: id, the alternate link, content, published", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
      <entry><id>tag:emergency.example.test,2026:1</id><title>Atom alert</title>
        <link rel="self" href="https://emergency.example.test/self"/><link rel="alternate" href="https://emergency.example.test/alerts/1"/>
        <content type="html">&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;</content><published>2026-10-06T21:15:00Z</published></entry></feed>`;
    expect(parseEmergencyFeed(xml).alerts).toEqual([
      { identity: "tag:emergency.example.test,2026:1", link: "https://emergency.example.test/alerts/1", title: "Atom alert", text: "One\n\nTwo", publishedAt: new Date("2026-10-06T21:15:00Z") },
    ]);
  });

  it("skips entries with no http(s) link or no title, and counts them", () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>No link</title><guid>g1</guid></item>
      <item><title>   </title><link>https://emergency.example.test/b</link></item>
      <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://emergency.example.test/c</link></item></channel></rss>`;
    const parsed = parseEmergencyFeed(xml);
    expect(parsed.alerts.map((a) => a.title)).toEqual(["Good"]);
    expect(parsed.skipped).toBe(3);
  });

  it("an HTML error page served with 200 is not a feed", () => {
    expect(() => parseEmergencyFeed("<!doctype html><html><body><h1>503 Service Unavailable</h1></body></html>")).toThrow(FeedFormatError);
  });

  it("a truncated body is rejected whole, so half an alert is never sent", () => {
    expect(() => parseEmergencyFeed(WORDPRESS.slice(0, WORDPRESS.indexOf("<ul>")))).toThrow(FeedFormatError);
  });

  it("caps the title and the text", () => {
    const longTitle = "T".repeat(MAX_TITLE_LENGTH + 50);
    const longBody = `<p>${"x".repeat(MAX_ALERT_TEXT + 50)}</p>`;
    const xml = `<rss version="2.0"><channel><item><title>${longTitle}</title><link>https://emergency.example.test/l</link><description><![CDATA[${longBody}]]></description></item></channel></rss>`;
    const [a] = parseEmergencyFeed(xml).alerts;
    expect(a!.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(a!.text).toHaveLength(MAX_ALERT_TEXT);
  });

  it("round-trips the fake feed, including a ']]>' inside the HTML", () => {
    const xml = renderFeedXml([{ guid: "g", link: "https://emergency.example.test/x", title: "A & B", html: "<p>odd ]]> text</p>", publishedAt: "2026-10-06T21:15:00.000Z" }]);
    expect(parseEmergencyFeed(xml).alerts).toEqual([
      { identity: "g", link: "https://emergency.example.test/x", title: "A & B", text: "odd ]]> text", publishedAt: new Date("2026-10-06T21:15:00Z") },
    ]);
  });

  it("strips a raw NUL and other control characters from the title, the text and the guid", () => {
    const xml = `<rss version="2.0"><channel><item><title>Evac\u0000uation order</title><link>https://emergency.example.test/a</link><guid>g\u0000uid-1</guid><description>Body\u0007text</description></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts).toEqual([
      { identity: "guid-1", link: "https://emergency.example.test/a", title: "Evacuation order", text: "Bodytext", publishedAt: null },
    ]);
  });

  it("strips bidi override characters from the title, which could otherwise spoof the email subject", () => {
    const xml = `<rss version="2.0"><channel><item><title>Safe‮evil.exe⁦hidden⁩</title><link>https://emergency.example.test/a</link></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts[0]!.title).toBe("Safeevil.exehidden");
  });

  it("a 10,000-deep nesting in one alert's HTML skips that alert, not the feed", () => {
    const deep = "<div>".repeat(10_000) + "x" + "</div>".repeat(10_000);
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link><description><![CDATA[${deep}]]></description></item><item><title>Fine</title><link>https://emergency.example.test/b</link></item></channel></rss>`;
    const parsed = parseEmergencyFeed(xml);
    expect(parsed.alerts.map((a) => a.title)).toEqual(["Fine"]);
    expect(parsed.skipped).toBe(1);
  });

  it("a 10,000-deep nesting in one alert's own XML skips that alert too", () => {
    const deep = "<x>".repeat(10_000) + "y" + "</x>".repeat(10_000);
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link><description>${deep}</description></item><item><title>Fine</title><link>https://emergency.example.test/b</link></item></channel></rss>`;
    const parsed = parseEmergencyFeed(xml);
    expect(parsed.alerts.map((a) => a.title)).toEqual(["Fine"]);
    expect(parsed.skipped).toBe(1);
  });

  it("never expands a billion-laughs DOCTYPE; the entity reference passes through literally", () => {
    const xml =
      `<?xml version="1.0"?><!DOCTYPE rss [` +
      `<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
      `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>` +
      `<rss version="2.0"><channel><item><title>Bomb &lol3; end</title><link>https://emergency.example.test/a</link></item></channel></rss>`;
    const { alerts, skipped } = parseEmergencyFeed(xml);
    expect(skipped).toBe(0);
    expect(alerts[0]!.title).toBe("Bomb &lol3; end");
  });

  it("never resolves a SYSTEM (XXE) entity; the reference passes through literally", () => {
    const xml =
      `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      `<rss version="2.0"><channel><item><title>Leak: &xxe;</title><link>https://emergency.example.test/a</link></item></channel></rss>`;
    const { alerts, skipped } = parseEmergencyFeed(xml);
    expect(skipped).toBe(0);
    expect(alerts[0]!.title).toBe("Leak: &xxe;");
  });

  it("allows trailing whitespace and a comment after the closing tag", () => {
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link></item></channel></rss>\n<!-- cached -->`;
    expect(parseEmergencyFeed(xml).alerts).toHaveLength(1);
  });

  it("falls back to the normalized link as identity, not the raw one", () => {
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>HTTP://Emergency.Example.Test/a/</link></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts[0]).toMatchObject({ identity: normalizeLinkIdentity("https://emergency.example.test/a") });
  });

  it("stores the link percent-encoded (URL#href), so odd characters never fail the item API's url check", () => {
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/café</link></item></channel></rss>`;
    expect(parseEmergencyFeed(xml).alerts[0]!.link).toBe("https://emergency.example.test/caf%C3%A9");
  });

  it("rejects a date outside Postgres's timestamptz-friendly range (year 1-9999) instead of an unusable one", () => {
    const farFuture = `<rss version="2.0"><channel><item><title>T</title><link>https://emergency.example.test/a</link><pubDate>Tue, 07 Oct 99999 12:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseEmergencyFeed(farFuture).alerts[0]!.publishedAt).toBeNull();

    const xml2 = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><title>T</title><link rel="alternate" href="https://emergency.example.test/b"/><published>0000-01-01T00:00:00Z</published></entry></feed>`;
    expect(parseEmergencyFeed(xml2).alerts[0]!.publishedAt).toBeNull();
  });
});

describe("normalizeLinkIdentity", () => {
  it("treats a trailing slash as the same link", () => {
    expect(normalizeLinkIdentity("https://emergency.example.test/a/")).toBe(normalizeLinkIdentity("https://emergency.example.test/a"));
  });
  it("treats http and https as the same link", () => {
    expect(normalizeLinkIdentity("http://emergency.example.test/a")).toBe(normalizeLinkIdentity("https://emergency.example.test/a"));
  });
  it("treats the host's case as insignificant", () => {
    expect(normalizeLinkIdentity("https://Emergency.Example.Test/a")).toBe(normalizeLinkIdentity("https://emergency.example.test/a"));
  });
});

describe("htmlToText", () => {
  it("drops style and script, keeps line breaks, collapses blank runs", () => {
    expect(htmlToText("<style>p{}</style><p>a<br>b</p>\n\n\n<div>c</div>")).toBe("a\nb\n\nc");
  });
  it("leaves a link's URL off when the link text already is the URL", () => {
    expect(htmlToText(`<a href="https://emergency.example.test/">https://emergency.example.test/</a>`)).toBe("https://emergency.example.test/");
  });
  it("is empty for empty input", () => {
    expect(htmlToText("   ")).toBe("");
  });
});
