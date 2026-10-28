import { describe, expect, it, vi } from "vitest";
import { bcSettings, prePlan4Settings } from "../../../packages/site-settings/src/fixtures";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { fillMissingFields, storedSiteSettingsSchema } from "@gcpe/site-settings";
import { currentSettings, liveJson, liveStreamUrl, settingsHashes, SITE_SETTINGS_PATH } from "./settings";

describe("currentSettings with a document published before the land acknowledgement existed", () => {
  const defaults = bcSettings();
  const legacy = () => {
    const d = structuredClone(defaults);
    delete d.footer.landAcknowledgement;
    return d;
  };

  it("fills the missing field from the tenant defaults and persists the filled document", async () => {
    const newsApi = fakeNewsApi();
    newsApi.settings = { revision: 3, document: legacy() };
    const storage = memoryStorage();
    const { settings } = await currentSettings({ newsApi, storage, defaults });
    expect(settings.footer.landAcknowledgement).toBe(defaults.footer.landAcknowledgement);
    expect(JSON.parse(storage.files.get(SITE_SETTINGS_PATH) as string).footer.landAcknowledgement).toBe(defaults.footer.landAcknowledgement);
  });

  it("keeps an explicit empty value (the band is hidden on purpose)", async () => {
    const newsApi = fakeNewsApi();
    const doc = structuredClone(defaults);
    doc.footer.landAcknowledgement = "";
    newsApi.settings = { revision: 4, document: doc };
    expect((await currentSettings({ newsApi, storage: memoryStorage(), defaults })).settings.footer.landAcknowledgement).toBe("");
  });

  it("fills a persisted pre-field document when the fetch fails", async () => {
    const storage = memoryStorage();
    await storage.write(SITE_SETTINGS_PATH, JSON.stringify(legacy()));
    const newsApi = fakeNewsApi();
    newsApi.siteSettings = async () => { throw new Error("down"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { settings, fallbackDefaults } = await currentSettings({ newsApi, storage, defaults });
    err.mockRestore();
    expect(fallbackDefaults).toBe(false);
    expect(settings.footer.landAcknowledgement).toBe(defaults.footer.landAcknowledgement);
  });

  it("steady state: the same pre-field document fetched again isn't rewritten, and the fetched and fallback paths hash alike", async () => {
    const newsApi = fakeNewsApi();
    newsApi.settings = { revision: 3, document: legacy() };
    const storage = memoryStorage();
    const writes = vi.spyOn(storage, "write");
    const first = await currentSettings({ newsApi, storage, defaults });
    expect(writes).toHaveBeenCalledTimes(1);
    const second = await currentSettings({ newsApi, storage, defaults });
    expect(writes).toHaveBeenCalledTimes(1); // nothing new to persist
    expect(second.settings).toEqual(first.settings);

    // The News API goes down: the persisted (already filled) copy gives the same hashes, so the
    // turn queues no settings rebuild.
    newsApi.siteSettings = async () => { throw new Error("down"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fallback = await currentSettings({ newsApi, storage, defaults });
    err.mockRestore();
    expect(fallback.fallbackDefaults).toBe(false);
    const now = new Date("2026-11-02T12:00:00Z");
    expect(settingsHashes(fallback.settings, "America/Vancouver", now)).toEqual(settingsHashes(first.settings, "America/Vancouver", now));
    expect(writes).toHaveBeenCalledTimes(1);
  });
});

describe("currentSettings with a document published before plan 4", () => {
  const defaults = bcSettings();

  it("a published document without the plan-4 parts parses and currentSettings returns it filled", async () => {
    const newsApi = fakeNewsApi();
    newsApi.settings = { revision: 7, document: prePlan4Settings() };
    const storage = memoryStorage();
    const { settings, fallbackDefaults } = await currentSettings({ newsApi, storage, defaults });
    expect(fallbackDefaults).toBe(false);
    expect(settings).toEqual(defaults);
    expect(JSON.parse(storage.files.get(SITE_SETTINGS_PATH) as string)).toEqual(defaults);
  });

  it("a pageText missing notFound, assetLicence or privacy entirely is refused, so the last applied settings stand", async () => {
    for (const part of ["notFound", "assetLicence", "privacy"] as const) {
      const doc = structuredClone(defaults) as Record<string, unknown> & typeof defaults;
      delete (doc.pageText as Partial<typeof doc.pageText>)[part];
      // The News API client parses with this schema; a refused body is a failed fetch.
      expect(storedSiteSettingsSchema.safeParse(doc).success, part).toBe(false);
    }
  });

  it("steady state: a pre-plan-4 document's section hashes are identical across fetch → persist → re-read, connect key order included", async () => {
    // As the client hands it over: parsed with the stored schema (zod emits keys in schema order).
    const fetched = storedSiteSettingsSchema.parse(JSON.parse(JSON.stringify(prePlan4Settings())));
    const newsApi = fakeNewsApi();
    newsApi.settings = { revision: 7, document: fetched };
    const storage = memoryStorage();
    const first = await currentSettings({ newsApi, storage, defaults });
    newsApi.siteSettings = async () => { throw new Error("down"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const reread = await currentSettings({ newsApi, storage, defaults });
    err.mockRestore();
    expect(reread.fallbackDefaults).toBe(false);
    // A document published after plan 4 (complete), as the client parses it.
    const complete = fillMissingFields(storedSiteSettingsSchema.parse(JSON.parse(JSON.stringify(defaults))), defaults);
    const now = new Date("2026-11-02T12:00:00Z");
    const h = (s: typeof defaults) => settingsHashes(s, "America/Vancouver", now);
    expect(h(reread.settings)).toEqual(h(first.settings));
    expect(h(first.settings)).toEqual(h(complete));
    for (const k of ["connect", "footer", "contactsPage", "pageText", "navigation"] as const) {
      expect(JSON.stringify(reread.settings[k]), k).toBe(JSON.stringify(first.settings[k]));
      expect(JSON.stringify(first.settings[k]), k).toBe(JSON.stringify(complete[k]));
    }
    expect(Object.keys(first.settings.connect)).toEqual(["facebook", "x", "instagram", "threads", "bluesky", "linkedin", "flickr", "youtube", "blogs", "policyLink", "intro"]);
  });

  it("a persisted .site-settings.json from before plan 4 is read and filled when the fetch fails", async () => {
    const storage = memoryStorage();
    await storage.write(SITE_SETTINGS_PATH, JSON.stringify(prePlan4Settings()));
    const newsApi = fakeNewsApi();
    newsApi.siteSettings = async () => { throw new Error("down"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { settings, fallbackDefaults } = await currentSettings({ newsApi, storage, defaults });
    err.mockRestore();
    expect(fallbackDefaults).toBe(false);
    expect(settings).toEqual(defaults);
  });
});

describe("live webcast", () => {
  const home = (u: string | null | undefined) => ({ liveWebcastM3uPlaylist: u });

  it("liveStreamUrl: https URL kept; http:, javascript:, '/x.m3u8' and null → null", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(liveStreamUrl(home("https://stream.example/live.m3u8"))).toBe("https://stream.example/live.m3u8");
      for (const bad of ["http://stream.example/live.m3u8", "javascript:alert(1)", "/x.m3u8", "//stream.example/x.m3u8", null, undefined, ""]) expect(liveStreamUrl(home(bad))).toBeNull();
      expect(liveStreamUrl({})).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("logs the non-https URL once per process, and never for an absent one", async () => {
    vi.resetModules();
    const fresh = await import("./settings");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fresh.liveStreamUrl(home(null));
      expect(err).not.toHaveBeenCalled();
      fresh.liveStreamUrl(home("http://a.example/x"));
      fresh.liveStreamUrl(home("javascript:1"));
      expect(err).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith("[public-site] live webcast URL is not https; shown as off air");
    } finally {
      err.mockRestore();
    }
  });

  it("liveJson holds only the flag, never the URL", () => {
    expect(liveJson(home("https://stream.example/live.m3u8"))).toBe('{"live":true}');
    expect(liveJson(home(null))).toBe('{"live":false}');
    expect(liveJson(home("http://stream.example/x"))).toBe('{"live":false}');
  });
});

describe("settingsHashes: header and labels", () => {
  const hashes = (mutate: (s: ReturnType<typeof bcSettings>) => void) => {
    const s = structuredClone(bcSettings());
    mutate(s);
    return settingsHashes(s, "America/Vancouver", new Date("2026-06-01T00:00:00Z"));
  };
  const base = hashes(() => {});

  it("header edits move headerHash only", () => {
    for (const m of [
      (s: ReturnType<typeof bcSettings>) => { s.navigation.newsLabel = "Newsroom"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.liveLabel = "Watch"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.headerLinks.push({ text: "X", url: "/x/" }); },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.showHeaderSearch = false; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.footerConnectHeading = "Hi"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.footerMoreInfoHeading = ""; },
    ]) {
      const h = hashes(m);
      expect(h.headerHash).not.toBe(base.headerHash);
      expect(h.labelsHash).toBe(base.labelsHash);
      expect(h.footerHash).toBe(base.footerHash);
    }
  });

  it("label and listing-title edits move labelsHash only", () => {
    for (const m of [
      (s: ReturnType<typeof bcSettings>) => { s.navigation.labels.searchNews = "Find"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.listingTitles.releases = "News releases"; },
    ]) {
      const h = hashes(m);
      expect(h.labelsHash).not.toBe(base.labelsHash);
      expect(h.headerHash).toBe(base.headerHash);
    }
  });

  it("an older-archive link edit moves searchTextHash only", () => {
    const h = hashes((s) => { s.pageText.searchArchiveLinks[0]!.text = "Older news"; });
    const changed = Object.keys(base).filter((k) => h[k as keyof typeof h] !== base[k as keyof typeof base]);
    expect(changed).toEqual(["searchTextHash"]);
  });
});
