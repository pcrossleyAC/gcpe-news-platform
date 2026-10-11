import { z } from "zod";
import { EmbeddingError, type EmbeddingProvider } from "./provider";
import { clampTimeoutMs } from "./timeout";

export const AZURE_EMBEDDING_MODEL = "text-embedding-3-small";
export const AZURE_EMBEDDING_DIMENSIONS = 1536;

export interface AzureOpenAiSettings {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  timeoutMs: number;
}

const responseSchema = z.object({ data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })) });

/** Azure OpenAI embeddings over its REST API (spec §4): dimensions pinned, every call timed out. */
export function azureOpenAiProvider(s: AzureOpenAiSettings, fetchImpl: typeof fetch = fetch): EmbeddingProvider {
  const url =
    `${s.endpoint.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(s.deployment)}` +
    `/embeddings?api-version=${encodeURIComponent(s.apiVersion)}`;
  const timeoutMs = clampTimeoutMs(s.timeoutMs);
  return {
    id: "azure-openai",
    model: AZURE_EMBEDDING_MODEL,
    dimensions: AZURE_EMBEDDING_DIMENSIONS,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "api-key": s.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ input: texts, dimensions: AZURE_EMBEDDING_DIMENSIONS }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new EmbeddingError(`embedding_http_${res.status}`);
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success || parsed.data.data.length !== texts.length) throw new EmbeddingError("embedding_bad_response");
      const sorted = [...parsed.data.data].sort((a, b) => a.index - b.index);
      if (sorted.some((d, i) => d.index !== i || d.embedding.length !== AZURE_EMBEDDING_DIMENSIONS)) {
        throw new EmbeddingError("embedding_bad_response");
      }
      return sorted.map((d) => d.embedding);
    },
  };
}
