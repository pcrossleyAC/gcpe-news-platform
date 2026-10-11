/**
 * Turns texts into vectors (spec §4). Implementations never log: the input is release text,
 * and failures are logged once by createGuardedEmbedder with the provider id and a safe label.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** One vector per text, in order. Rejects on any failure; never returns a partial result. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** A provider failure whose `code` is safe to log (safeErrorLabel reads it). */
export class EmbeddingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmbeddingError";
  }
}
