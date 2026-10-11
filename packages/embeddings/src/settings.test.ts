import { describe, expect, it } from "vitest";
import { clampTimeoutMs, createEmbeddingProvider, embeddingsEnvSchema } from "./settings";

const parse = (env: Record<string, string | undefined>) => embeddingsEnvSchema.safeParse(env);
const azure = {
  EMBEDDINGS_PROVIDER: "azure-openai",
  AZURE_OPENAI_ENDPOINT: "https://embeddings.example.test",
  AZURE_OPENAI_API_KEY: "test-key-not-real",
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed-small",
};

describe("clampTimeoutMs", () => {
  it.each([
    [undefined, 1000], ["", 1000], ["abc", 1000], ["50", 200], ["200", 200], ["1500", 1500], ["9000", 5000], [750, 750],
  ])("%j -> %d", (raw, expected) => {
    expect(clampTimeoutMs(raw as string | number | undefined)).toBe(expected);
  });
});

describe("embeddingsEnvSchema and createEmbeddingProvider", () => {
  it("means full-text only (null) when no provider is set, or it is blank", () => {
    for (const env of [{}, { EMBEDDINGS_PROVIDER: "" }]) {
      const r = parse(env);
      expect(r.success).toBe(true);
      expect(createEmbeddingProvider(r.data!)).toBeNull();
    }
  });

  it("builds the stand-in outside production", () => {
    const r = parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "development" });
    expect(createEmbeddingProvider(r.data!)?.id).toBe("stand-in");
  });

  it("refuses the stand-in on a real production deployment", () => {
    const r = parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["EMBEDDINGS_PROVIDER"]);
    expect(r.error!.issues[0]!.message).toMatch(/production/);
  });

  it.each([{ LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" }, { SITE_ENVIRONMENT: "test" }])(
    "allows the stand-in on a production-mode test deployment (%j), as boxs.ca is",
    (extra) => {
      expect(parse({ EMBEDDINGS_PROVIDER: "stand-in", NODE_ENV: "production", ...extra }).success).toBe(true);
    },
  );

  it("builds the Azure provider with the default API version and the clamped timeout", () => {
    const r = parse({ ...azure, EMBEDDINGS_TIMEOUT_MS: "99999" });
    expect(r.success).toBe(true);
    expect(r.data!.AZURE_OPENAI_API_VERSION).toBe("2024-10-21");
    expect(r.data!.EMBEDDINGS_TIMEOUT_MS).toBe(5000);
    expect(createEmbeddingProvider(r.data!)?.id).toBe("azure-openai");
  });

  it.each(["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] as const)(
    "requires %s for azure-openai, naming it",
    (missing) => {
      const { [missing]: _gone, ...rest } = azure;
      const r = parse(rest);
      expect(r.success).toBe(false);
      expect(r.error!.issues.map((i) => i.path[0])).toContain(missing);
    },
  );

  it("refuses an unknown provider name", () => {
    expect(parse({ EMBEDDINGS_PROVIDER: "openai" }).success).toBe(false);
  });
});
