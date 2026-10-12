import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword, mintLocalToken, NEWS_API_SIMILAR_ROLE } from "@gcpe/auth";
import type { EmbeddingProvider } from "@gcpe/embeddings";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, writeTenantConfig } from "../../test/helpers";
import { applyRelease } from "../projections";
import { startNewsApi } from "../start";

const MARKER = "quokkadraftmarker";
const draftCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock("@gcpe/embeddings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@gcpe/embeddings")>();
  const spy = (p: EmbeddingProvider): EmbeddingProvider => ({
    ...p,
    async embed(texts, signal) {
      if (texts.some((t) => t.includes(MARKER))) draftCalls.n++;
      return p.embed(texts, signal);
    },
  });
  return { ...real, createEmbeddingProvider: (...args: Parameters<typeof real.createEmbeddingProvider>) => { const p = real.createEmbeddingProvider(...args); return p && spy(p); } };
});

const SECRET = "f".repeat(40);

describe("staff-AI flag enforcement (spec §9)", () => {
  afterEach(() => {
    draftCalls.n = 0;
  });

  it.each([
    [false, "text", 0],
    [true, "ai", 1],
  ] as const)("News API staffAi=%s: mode %s, %i provider call(s) for the draft, though the caller asked for ai", async (staffAi, mode, calls) => {
    const own = await createNewsTestDb();
    const handle = await startNewsApi(
      {
        DATABASE_URL: own.url,
        EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
        // semanticSearch on, so the worker embeds posts and the provider is live: only staffAi differs.
        TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: true, staffAi } }),
        EMBEDDINGS_PROVIDER: "stand-in",
        SLIDE_IMAGES_FETCH_BASE: "http://files.internal.test",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("pw-for-tests-only"),
        LOCAL_AUTH_SECRET: SECRET,
      },
      { hub: false },
    );
    try {
      await own.db.transaction((tx) =>
        applyRelease(tx, { ...sampleRelease, key: "FLAG-1", documents: [{ ...sampleRelease.documents[0]!, headline: "salmon habitat restoration" }] }, { notify: false }),
      );
      await handle.workers.embed!();
      const token = await mintLocalToken({ secret: SECRET, subject: "nrms", roles: [NEWS_API_SIMILAR_ROLE] });
      const res = await request(handle.app)
        .post("/api/v2/internal/similar")
        .set("authorization", `Bearer ${token}`)
        .send({ text: `${MARKER} salmon habitat restoration`, terms: "salmon habitat restoration", mode: "ai" });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe(mode);
      expect(draftCalls.n).toBe(calls);
    } finally {
      await closeHandle(handle);
      await own.drop();
    }
  });
});
