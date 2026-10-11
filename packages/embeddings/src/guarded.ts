import { safeErrorLabel } from "@gcpe/http-kit";
import { BreakerOpenError, CircuitBreaker } from "./breaker";
import type { EmbeddingProvider } from "./provider";

export interface GuardedEmbedder {
  readonly provider: EmbeddingProvider;
  readonly breaker: CircuitBreaker;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * A provider behind a breaker. The one place a provider failure is logged: the provider id and
 * safeErrorLabel only, never the texts (spec §4). An open breaker isn't logged; it isn't a call.
 */
export function createGuardedEmbedder(opts: {
  provider: EmbeddingProvider;
  breaker?: CircuitBreaker;
  log?: (line: string) => void;
}): GuardedEmbedder {
  const { provider } = opts;
  const breaker = opts.breaker ?? new CircuitBreaker();
  const log = opts.log ?? ((line: string) => console.error(line));
  return {
    provider,
    breaker,
    async embed(texts, signal) {
      try {
        return await breaker.run(() => provider.embed(texts, signal));
      } catch (e) {
        if (!(e instanceof BreakerOpenError)) log(`[embeddings] ${provider.id} call failed ${safeErrorLabel(e)}`);
        throw e;
      }
    },
  };
}
