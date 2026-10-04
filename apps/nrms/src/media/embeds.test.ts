import { describe, expect, it, vi } from "vitest";
import type { FlickrClient } from "./flickr-client";
import { FlickrError } from "./flickr-client";
import { defaultSoundcloudOembed, normalizeEmbeds, type EmbedDeps } from "./embeds";

function fakeFlickr(behaviour: (pageUrl: string) => Promise<string>): FlickrClient {
  return {
    getVisibility: () => Promise.reject(new Error("not used")),
    makePublic: () => Promise.reject(new Error("not used")),
    confirmPublic: () => Promise.reject(new Error("not used")),
    staticImageUrl: behaviour,
  };
}

const neverSoundcloud = (): Promise<string | null> => Promise.reject(new Error("soundcloud not expected"));

describe("normalizeEmbeds", () => {
  it("leaves a body without <asset> unchanged and makes no calls", async () => {
    const flickr = fakeFlickr(() => Promise.reject(new Error("should not be called")));
    const soundcloudOembed = vi.fn(neverSoundcloud);
    const html = "<p>No embeds here.</p>";
    expect(await normalizeEmbeds(html, { flickr, soundcloudOembed })).toBe(html);
    expect(soundcloudOembed).not.toHaveBeenCalled();
  });

  it("youtu.be short links resolve to the canonical watch URL", async () => {
    const html = "<p>Watch:</p><asset>https://youtu.be/abcdef12345</asset>";
    const out = await normalizeEmbeds(html, { flickr: null, soundcloudOembed: neverSoundcloud });
    expect(out).toBe("<p>Watch:</p><asset>https://www.youtube.com/watch?v=abcdef12345</asset>");
  });

  it("youtube.com/watch and /shorts also resolve", async () => {
    const deps: EmbedDeps = { flickr: null, soundcloudOembed: neverSoundcloud };
    expect(await normalizeEmbeds("<asset>https://www.youtube.com/watch?v=abcdef12345</asset>", deps)).toBe(
      "<asset>https://www.youtube.com/watch?v=abcdef12345</asset>",
    );
    expect(await normalizeEmbeds("<asset>https://youtube.com/shorts/abcdef12345</asset>", deps)).toBe(
      "<asset>https://www.youtube.com/watch?v=abcdef12345</asset>",
    );
  });

  it("a *.staticflickr.com image URL is kept, upgraded to https", async () => {
    const html = "<asset>http://live.staticflickr.com/1/2_x_b.jpg</asset>";
    const out = await normalizeEmbeds(html, { flickr: null, soundcloudOembed: neverSoundcloud });
    expect(out).toBe("<asset>https://live.staticflickr.com/1/2_x_b.jpg</asset>");
  });

  it("a public Flickr page resolves through the client's staticImageUrl", async () => {
    const flickr = fakeFlickr(async (pageUrl) => {
      expect(pageUrl).toBe("https://www.flickr.com/photos/bcgovphotos/53212345678/");
      return "https://live.staticflickr.com/1/53212345678_abc_b.jpg";
    });
    const html = "<asset>https://www.flickr.com/photos/bcgovphotos/53212345678/</asset>";
    const out = await normalizeEmbeds(html, { flickr, soundcloudOembed: neverSoundcloud });
    expect(out).toBe("<asset>https://live.staticflickr.com/1/53212345678_abc_b.jpg</asset>");
  });

  it("a private (or otherwise failing) Flickr page degrades to a plain link", async () => {
    const flickr = fakeFlickr(() => Promise.reject(new FlickrError("not-found", "Flickr oEmbed: photo not found or not public")));
    const html = "<asset>https://www.flickr.com/photos/bcgovphotos/53000000001/</asset>";
    const out = await normalizeEmbeds(html, { flickr, soundcloudOembed: neverSoundcloud });
    expect(out).toBe('<a href="https://www.flickr.com/photos/bcgovphotos/53000000001/">https://www.flickr.com/photos/bcgovphotos/53000000001/</a>');
  });

  it("Flickr not configured (flickr: null) degrades a Flickr page to a plain link", async () => {
    const html = "<asset>https://www.flickr.com/photos/bcgovphotos/53212345678/</asset>";
    const out = await normalizeEmbeds(html, { flickr: null, soundcloudOembed: neverSoundcloud });
    expect(out).toBe('<a href="https://www.flickr.com/photos/bcgovphotos/53212345678/">https://www.flickr.com/photos/bcgovphotos/53212345678/</a>');
  });

  it("a SoundCloud URL resolves to the oEmbed-returned canonical URL", async () => {
    const url = "https://soundcloud.com/some-artist/some-track";
    const ok = await normalizeEmbeds(`<asset>${url}</asset>`, { flickr: null, soundcloudOembed: () => Promise.resolve("https://soundcloud.com/some-artist/some-track-canonical") });
    expect(ok).toBe("<asset>https://soundcloud.com/some-artist/some-track-canonical</asset>");
  });

  it("a SoundCloud lookup failure (null or throw) keeps the embed as an https asset, never degrading to a link", async () => {
    const url = "http://soundcloud.com/some-artist/some-track";
    const httpsUrl = "https://soundcloud.com/some-artist/some-track";

    // Fails on the very first save.
    const firstSaveFails = await normalizeEmbeds(`<asset>${url}</asset>`, { flickr: null, soundcloudOembed: () => Promise.resolve(null) });
    expect(firstSaveFails).toBe(`<asset>${httpsUrl}</asset>`);

    // Resolves on first save, then SoundCloud is down on a later, unrelated save — the already-
    // resolved asset must not be silently and permanently downgraded to a plain link.
    const resolved = await normalizeEmbeds(`<asset>${url}</asset>`, { flickr: null, soundcloudOembed: () => Promise.resolve(httpsUrl) });
    expect(resolved).toBe(`<asset>${httpsUrl}</asset>`);
    const resavedWhileDown = await normalizeEmbeds(resolved, { flickr: null, soundcloudOembed: () => Promise.reject(new Error("down")) });
    expect(resavedWhileDown).toBe(`<asset>${httpsUrl}</asset>`);
  });

  it("rejects an oEmbed canonical URL that isn't https on a soundcloud.com host, keeping the original instead", async () => {
    const url = "https://soundcloud.com/some-artist/some-track";
    const httpCanonical = await normalizeEmbeds(`<asset>${url}</asset>`, { flickr: null, soundcloudOembed: () => Promise.resolve("http://soundcloud.com/other") });
    expect(httpCanonical).toBe(`<asset>${url}</asset>`);
    const otherHost = await normalizeEmbeds(`<asset>${url}</asset>`, { flickr: null, soundcloudOembed: () => Promise.resolve("https://evil.example/x") });
    expect(otherHost).toBe(`<asset>${url}</asset>`);
  });

  it("any other http(s) URL becomes a plain link", async () => {
    const html = "<asset>https://example.com/x</asset>";
    const out = await normalizeEmbeds(html, { flickr: null, soundcloudOembed: neverSoundcloud });
    expect(out).toBe('<a href="https://example.com/x">https://example.com/x</a>');
  });

  it("a javascript: URL or unparsable content is removed entirely", async () => {
    const deps: EmbedDeps = { flickr: null, soundcloudOembed: neverSoundcloud };
    expect(await normalizeEmbeds("<p>x</p><asset>javascript:alert(1)</asset>", deps)).toBe("<p>x</p>");
    expect(await normalizeEmbeds("<p>x</p><asset>not a url</asset>", deps)).toBe("<p>x</p>");
  });

  it("decodes HTML entities before parsing the URL", async () => {
    // The sanitiser HTML-encodes "&" as "&amp;"; decoded, the id "abc" is too short for YouTube.
    const html = "<asset>https://youtu.be/abc&amp;x=1</asset>";
    const out = await normalizeEmbeds(html, { flickr: null, soundcloudOembed: neverSoundcloud });
    expect(out).toBe('<a href="https://youtu.be/abc&amp;x=1">https://youtu.be/abc&amp;x=1</a>');
  });

  it("caps network-backed resolution at maxEmbeds; extras become plain links without calls", async () => {
    let calls = 0;
    const flickr = fakeFlickr(async (pageUrl) => {
      calls++;
      return pageUrl.replace("flickr.com/photos", "live.staticflickr.com/x").concat("_b.jpg");
    });
    const urls = Array.from({ length: 12 }, (_, i) => `https://www.flickr.com/photos/user/${i}/`);
    const html = urls.map((u) => `<asset>${u}</asset>`).join("");
    const out = await normalizeEmbeds(html, { flickr, soundcloudOembed: neverSoundcloud });
    const assetCount = out.split("<asset>").length - 1;
    const linkCount = out.split("<a href=").length - 1;
    expect(assetCount).toBe(10);
    expect(linkCount).toBe(2);
    expect(calls).toBeLessThanOrEqual(10);
    // The last two, positionally, are the plain links (no network call attempted for them).
    expect(out).toContain(`<a href="${urls[10]}">${urls[10]}</a>`);
    expect(out).toContain(`<a href="${urls[11]}">${urls[11]}</a>`);
  });

  it("maxEmbeds is configurable", async () => {
    const flickr = fakeFlickr(async () => "https://live.staticflickr.com/x_b.jpg");
    const html = "<asset>https://www.flickr.com/photos/user/1/</asset><asset>https://www.flickr.com/photos/user/2/</asset>";
    const out = await normalizeEmbeds(html, { flickr, soundcloudOembed: neverSoundcloud, maxEmbeds: 1 });
    expect(out.split("<asset>").length - 1).toBe(1);
    expect(out.split("<a href=").length - 1).toBe(1);
  });
});

describe("defaultSoundcloudOembed", () => {
  it("returns the response's url field on HTTP 200", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ url: "https://soundcloud.com/canonical" }), { status: 200 }));
    const oembed = defaultSoundcloudOembed(fetchImpl as unknown as typeof fetch);
    expect(await oembed("https://soundcloud.com/a/b")).toBe("https://soundcloud.com/canonical");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent("https://soundcloud.com/a/b"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to the input URL on HTTP 200 without a url field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ title: "A track" }), { status: 200 }));
    const oembed = defaultSoundcloudOembed(fetchImpl as unknown as typeof fetch);
    expect(await oembed("https://soundcloud.com/a/b")).toBe("https://soundcloud.com/a/b");
  });

  it("returns null on a non-200 response or a network error", async () => {
    const notFound = defaultSoundcloudOembed((async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    expect(await notFound("https://soundcloud.com/a/b")).toBeNull();
    const broken = defaultSoundcloudOembed((async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    expect(await broken("https://soundcloud.com/a/b")).toBeNull();
  });
});
