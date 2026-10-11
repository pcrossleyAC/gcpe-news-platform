import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMBEDDING_SOURCE_MAX_CHARS, embeddingSourceText, embeddingTextHash } from "./source-text";

describe("embedding source text (spec §5.2)", () => {
  it("is the search text itself up to 8,000 characters", () => {
    const text = "a".repeat(EMBEDDING_SOURCE_MAX_CHARS);
    expect(embeddingSourceText(text)).toBe(text);
  });

  it("keeps the first 8,000 code points, never half a surrogate pair", () => {
    expect(embeddingSourceText("a".repeat(8001))).toBe("a".repeat(8000));
    const astral = "a".repeat(7999) + "😀😀";
    expect(embeddingSourceText(astral)).toBe("a".repeat(7999) + "😀");
  });

  it("hashes the source text with SHA-256, so text past 8,000 characters doesn't change it", () => {
    const base = "b".repeat(8000);
    expect(embeddingTextHash(base)).toBe(createHash("sha256").update(base, "utf8").digest("hex"));
    expect(embeddingTextHash(base + "more")).toBe(embeddingTextHash(base));
    expect(embeddingTextHash("c" + base.slice(1))).not.toBe(embeddingTextHash(base));
  });
});
