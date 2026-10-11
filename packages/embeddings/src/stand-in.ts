import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider";
import { normaliseForEmbedding } from "./text";

export const STAND_IN_MODEL = "stand-in-sha256-v1";

/**
 * Each normalised word's SHA-256 picks four (index, sign) slots; the sum is scaled to unit
 * length. Fixed output for a given text, and texts that share words share slots, so they are
 * closer: enough for ranking tests to mean something. Not a language model.
 */
function vectorFor(text: string, dimensions: number): number[] {
  const words = normaliseForEmbedding(text).split(" ").filter((w) => w.length > 0);
  const v = new Float64Array(dimensions);
  for (const word of words.length > 0 ? words : [""]) {
    const h = createHash("sha256").update(word, "utf8").digest();
    for (let k = 0; k < 4; k++) {
      const index = h.readUInt32BE(k * 8) % dimensions;
      v[index]! += (h[k * 8 + 4]! & 1) === 1 ? 1 : -1;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return Array.from(v, (x) => x / norm);
}

export function standInProvider(opts: { dimensions?: number } = {}): EmbeddingProvider {
  const dimensions = opts.dimensions ?? 1536;
  return {
    id: "stand-in",
    model: STAND_IN_MODEL,
    dimensions,
    async embed(texts) {
      return texts.map((t) => vectorFor(t, dimensions));
    },
  };
}
