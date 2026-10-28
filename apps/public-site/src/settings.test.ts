import { describe, expect, it, vi } from "vitest";
import { bcSettings, prePlan4Settings } from "../../../packages/site-settings/src/fixtures";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { fillMissingFields, storedSiteSettingsSchema } from "@gcpe/site-settings";
import { currentSettings, settingsHashes, SITE_SETTINGS_PATH } from "./settings";

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
