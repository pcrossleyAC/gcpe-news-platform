import { describe, expect, it, vi } from "vitest";
import type { Tx } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createRebuildHandler, enqueueSiteWrite, resyncPostPages, tryHome } from "./rebuild";
import type { NewsApiClient } from "./news-api-client";
import type { SiteStorage } from "./storage";
import type { PostDto } from "./render";

const site = { name: "BC Gov News", baseUrl: "https://news.example" };

function memoryStorage(): SiteStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(relPath, html) {
      files.set(relPath, html);
    },
    async remove(relPath) {
      files.delete(relPath);
    },
    async exists(relPath) {
      return files.has(relPath);
    },
    async read(relPath) {
      return files.get(relPath) ?? null;
    },
    async listDirs(relPath) {
      const prefix = `${relPath}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split("/")[0];
        if (seg) names.add(seg);
      }
      return [...names];
    },
  };
}

const post: PostDto = {
  key: "K1",
  kind: "releases",
  publishDate: "2026-10-03T10:00:00-07:00",
  summary: null,
  location: null,
  ministryKeys: [],
  documents: [{ languageId: 4105, headline: "Headline", subheadline: null, detailsHtml: "<p>x</p>", contacts: [] }],
};

function envelope(data: unknown): EventEnvelope {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "site.rebuild_requested",
    version: 1,
    source: "news-api",
    aggregateId: "site",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    correlationId: "00000000-0000-0000-0000-000000000002",
    data,
  };
}

describe("createRebuildHandler", () => {
  it("writes the home page and a post page for pages [home, post:K1]", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async (key: string) => (key === "K1" ? post : null)),
      latestHome: vi.fn(async () => [post]),
      home: vi.fn(async () => ({ granville: null })),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("removes the page for an unpublished post (getPost -> null)", async () => {
    const storage = memoryStorage();
    storage.files.set("releases/K1/index.html", "<p>stale</p>");
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => null), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("skips a path-escaping id and an unknown id without writing or throwing", async () => {
    const storage = memoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["post:../../x", "ministry:health"] }))).resolves.toBeUndefined();
    // Fix round 1: the run also writes the site-render-state marker (no post pages existed on
    // disk to resync, so that's the only file written).
    expect([...storage.files.keys()]).toEqual([".site-state.json"]);
    expect(newsApi.getPost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("ignores a post whose returned key doesn't match the requested key, leaving other files untouched (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: ".." })), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    // Fix round 1: the run also writes the marker — nothing else for the post:K1 page itself.
    // No pre-existing index.html here, so I1's resync has nothing to re-render either.
    expect([...storage.files.keys()].sort()).toEqual([".site-state.json"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes at the requested key's path (not the API response's casing) when the keys only differ by case (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: "k1" })), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(storage.files.has("releases/k1/index.html")).toBe(false);
  });

  it("rejects when the News API is down, so the receiver 500s and the dispatcher retries", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => {
        throw new Error("News API down");
      }),
      latestHome: vi.fn(async () => []),
      home: vi.fn(async () => ({ granville: null })),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["post:K1"] }))).rejects.toThrow("News API down");
  });

  // Important 1 (fix round 1): a home() failure must propagate — never swallowed and reported
  // as a success with no (or a stale) banner.
  it("propagates a home() failure instead of swallowing it, so the dispatcher retries", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => post),
      latestHome: vi.fn(async () => [post]),
      home: vi.fn(async () => {
        throw new Error("News API down");
      }),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["home"] }))).rejects.toThrow("News API down");
    expect(storage.files.has("index.html")).toBe(false); // nothing written on failure
  });

  it("fetches home() once per run (not per page) and renders the banner on every page written", async () => {
    const storage = memoryStorage();
    const home = vi.fn(async () => ({ granville: "true" }));
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(home).toHaveBeenCalledTimes(1);
    expect(storage.files.get("index.html")).toContain("blue-bridge-banner");
    expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
  });

  it("a test site's pages carry the TEST-prefixed banner and the noindex meta", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: true });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(storage.files.get("index.html")).toContain("TEST — ALERT:");
    expect(storage.files.get("index.html")).toContain("noindex");
    expect(storage.files.get("releases/K1/index.html")).toContain("TEST — ALERT:");
  });

  // CRITICAL (fix round 1): post pages are static files with the banner baked in — a
  // home-only rebuild must still re-render every post page already on disk when granville
  // flips, since the dispatcher otherwise only ever rebuilds the pages the event names.
  describe("resyncing existing post pages when the Blue Bridge/test state changes", () => {
    it("ON -> OFF: a home-only rebuild strips the banner from an existing post page", async () => {
      const storage = memoryStorage();
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");

      newsApi.home = vi.fn(async () => ({ granville: null }));
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");
    });

    it("OFF -> ON: a home-only rebuild adds the banner to an existing post page", async () => {
      const storage = memoryStorage();
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: null })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");

      newsApi.home = vi.fn(async () => ({ granville: "true" }));
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
    });

    it("unchanged state: a later rebuild doesn't re-fetch/re-render posts not in its own pages", async () => {
      const storage = memoryStorage();
      const getPost = vi.fn(async () => post);
      const newsApi: NewsApiClient = { getPost, latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(getPost).toHaveBeenCalledTimes(1);

      // Same granville, same test — a second, unrelated home-only rebuild must not touch K1.
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(getPost).toHaveBeenCalledTimes(1); // still just the one call from the first run
    });

    // The daily age bump alone (granville unchanged, same "on") must never trigger a resync —
    // only on/off or test/production changing does.
    it("the banner's age ticking over a day doesn't by itself trigger a resync", async () => {
      const storage = memoryStorage();
      const getPost = vi.fn(async () => post);
      const newsApi: NewsApiClient = { getPost, latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: ...age of 77");
      storage.files.set("releases/K1/index.html", "<p>stale but unrelated to the marker check</p>");
      await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: ...age of 78");
      expect(storage.files.get("releases/K1/index.html")).toBe("<p>stale but unrelated to the marker check</p>");
    });

    // I1: index.html is itself a static page with the chrome baked in, same as every post page —
    // a home-only rebuild's resync must re-render it too, not just releases/*, or it keeps
    // whatever chrome it had from the last time it was actually rendered.
    it("I1: re-renders an already-existing index.html when the Blue Bridge/test state changes", async () => {
      const storage = memoryStorage();
      storage.files.set("index.html", "<p>stale home, pre-fix</p>");
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      // "pages" deliberately omits "home" — only resyncPostPages's own index.html re-render
      // (not createRebuildHandler's explicit pages loop) can be responsible for the change.
      await handler({} as Tx, envelope({ pages: ["post:K1"] }));
      expect(storage.files.get("index.html")).toContain("blue-bridge-banner");
      expect(storage.files.get("index.html")).not.toBe("<p>stale home, pre-fix</p>");
    });

    // I1: a brand-new output dir has no index.html yet — that's selfHeal's bootstrap job, not
    // resyncPostPages's; resyncPostPages must not pre-empt it by writing a (possibly
    // under-populated) index.html of its own before the bootstrap ever runs.
    it("I1: never writes index.html when it doesn't already exist (leaves that to selfHeal's bootstrap)", async () => {
      const storage = memoryStorage();
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: ...");
      expect(storage.files.has("index.html")).toBe(false);
    });

    // Minor 1: one post whose getPost keeps failing must not block the resync of every other
    // post, nor the event's own requested pages — and the marker must not be written, so the
    // next run retries the failing post too instead of silently giving up on it forever.
    it("Minor 1: a post whose getPost keeps failing is skipped and logged; other pages still render; the marker isn't written", async () => {
      const storage = memoryStorage();
      storage.files.set("releases/K1/index.html", "<p>stale K1</p>");
      storage.files.set("releases/K2/index.html", "<p>stale K2</p>");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const newsApi: NewsApiClient = {
          getPost: vi.fn(async (key: string) => {
            if (key === "K1") throw new Error("News API down for K1");
            return { ...post, key };
          }),
          latestHome: vi.fn(async () => [post]),
          home: vi.fn(async () => ({ granville: "true" })),
        };
        const handler = createRebuildHandler({ newsApi, storage, site, test: false });
        // "post:K3" is this event's own explicitly requested page — must still render even
        // though the K1 resync failed.
        await expect(handler({} as Tx, envelope({ pages: ["post:K3"] }))).resolves.toBeUndefined();

        expect(storage.files.get("releases/K1/index.html")).toBe("<p>stale K1</p>"); // skipped, left alone
        expect(storage.files.get("releases/K2/index.html")).toContain("blue-bridge-banner"); // resynced fine
        expect(storage.files.has("releases/K3/index.html")).toBe(true); // the event's own page
        expect(storage.files.has(".site-state.json")).toBe(false); // marker withheld — retry next time
        expect(errSpy).toHaveBeenCalled();

        // Next run: K1 still fails, but since the marker was never written, it's retried (not
        // silently skipped forever) and K2 is resynced again too.
        storage.files.set("releases/K2/index.html", "<p>stale K2 again</p>");
        await handler({} as Tx, envelope({ pages: [] }));
        expect(storage.files.get("releases/K2/index.html")).toContain("blue-bridge-banner");
        expect(storage.files.has(".site-state.json")).toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});

describe("tryHome", () => {
  it("returns home()'s result on success", async () => {
    const newsApi = { home: vi.fn(async () => ({ granville: "true" })) } as unknown as NewsApiClient;
    expect(await tryHome(newsApi)).toEqual({ granville: "true" });
  });

  it("never throws: logs and returns null on failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const newsApi = {
        home: vi.fn(async () => {
          throw new Error("News API down");
        }),
      } as unknown as NewsApiClient;
      expect(await tryHome(newsApi)).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("resyncPostPages", () => {
  it("re-renders every post key found on disk under releases/, skipping non-post entries", async () => {
    const storage = memoryStorage();
    storage.files.set("releases/K1/index.html", "<p>stale</p>");
    storage.files.set("releases/K2/index.html", "<p>stale</p>");
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async (key: string) => ({ ...post, key })),
      latestHome: vi.fn(async () => []),
      home: vi.fn(async () => ({ granville: "true" })),
    };
    await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: banner text");
    expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
    expect(storage.files.get("releases/K2/index.html")).toContain("blue-bridge-banner");
    expect(newsApi.getPost).toHaveBeenCalledTimes(2);
  });

  it("a missing marker always counts as changed, even against an all-off state (writes the marker the first time)", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    await resyncPostPages({ newsApi, storage, site }, { granvilleOn: false, test: false }, null);
    expect(storage.files.get(".site-state.json")).toBe(JSON.stringify({ granvilleOn: false, test: false }));
  });
});

// Fix round 2 (Important): selfHeal runs after app.listen(), so it can overlap an inbound
// rebuild event in the same process — both createRebuildHandler and selfHeal go through
// enqueueSiteWrite so their turns (home()/test read, compare-to-marker, render, write-marker)
// can never interleave.
describe("enqueueSiteWrite / resync serialisation", () => {
  it("serialises turns in enqueue order: the second's task function doesn't even start until the first's turn has fully settled", async () => {
    const storage = memoryStorage();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const p1 = enqueueSiteWrite(storage, async () => {
      order.push("start1");
      await gate;
      order.push("end1");
    });
    const p2 = enqueueSiteWrite(storage, async () => {
      order.push("start2");
      order.push("end2");
    });

    // Neither turn's body has run yet — enqueueSiteWrite only schedules them (as microtask
    // continuations); starting task2 must wait for task1's entire chained promise to settle.
    expect(order).toEqual([]);
    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("two overlapping rebuilds with different granville — the later-enqueued one (OFF) wins the final pages and marker, and never interleaves with the first (ON)", async () => {
    const storage = memoryStorage();
    const order: string[] = [];
    let releaseFirstHome: ((v: { granville: string | null }) => void) | undefined;
    const firstHomeGate = new Promise<{ granville: string | null }>((resolve) => (releaseFirstHome = resolve));

    let call = 0;
    const home = vi.fn(async () => {
      call++;
      if (call === 1) {
        order.push("start-home-1(ON, gated)");
        const result = await firstHomeGate;
        order.push("end-home-1(ON)");
        return result;
      }
      order.push("home-2(OFF)");
      return { granville: null };
    });
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });

    const p1 = handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    const p2 = handler({} as Tx, envelope({ pages: ["home"] }));

    releaseFirstHome!({ granville: "true" });
    await Promise.all([p1, p2]);

    expect(order).toEqual(["start-home-1(ON, gated)", "end-home-1(ON)", "home-2(OFF)"]);
    expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");
    expect(storage.files.get("index.html")).not.toContain("blue-bridge-banner");
    expect(JSON.parse(storage.files.get(".site-state.json")!)).toEqual({ granvilleOn: false, test: false });
  });

  it("a rejected turn doesn't wedge the queue — a concurrently-enqueued later turn still runs", async () => {
    const storage = memoryStorage();
    let call = 0;
    const home = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("News API down");
      return { granville: null };
    });
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });

    const p1 = handler({} as Tx, envelope({ pages: ["home"] }));
    const p2 = handler({} as Tx, envelope({ pages: ["home"] }));
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    expect(r1.status).toBe("rejected");
    expect(r1.status === "rejected" && r1.reason).toMatchObject({ message: "News API down" });
    expect(r2.status).toBe("fulfilled");
    expect(storage.files.has("index.html")).toBe(true); // the second turn still ran and wrote its page
  });

  it("a rejected turn's queue slot still settles sequentially: a later call made after awaiting it runs normally", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => post),
      latestHome: vi.fn(async () => [post]),
      home: vi.fn(async () => {
        throw new Error("News API down");
      }),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["home"] }))).rejects.toThrow("News API down");

    newsApi.home = vi.fn(async () => ({ granville: null }));
    await expect(handler({} as Tx, envelope({ pages: ["home"] }))).resolves.toBeUndefined();
    expect(storage.files.has("index.html")).toBe(true);
  });
});
