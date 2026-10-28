import { describe, expect, it, vi } from "vitest";
import { bcSettings } from "../../../packages/site-settings/src/fixtures";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { currentSettings, SITE_SETTINGS_PATH } from "./settings";

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
});
