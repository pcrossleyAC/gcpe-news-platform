export { EmbeddingError, type EmbeddingProvider } from "./provider";
export { collapseWhitespace, htmlToPlainText, normaliseForEmbedding } from "./text";
export { standInProvider, STAND_IN_MODEL } from "./stand-in";
export { AZURE_EMBEDDING_DIMENSIONS, AZURE_EMBEDDING_MODEL, azureOpenAiProvider, type AzureOpenAiSettings } from "./azure-openai";
export { clampTimeoutMs } from "./timeout";
export {
  createEmbeddingProvider,
  DEFAULT_AZURE_API_VERSION,
  embeddingsEnvSchema,
  embeddingsEnvShape,
  refineEmbeddingsEnv,
  type EmbeddingsEnv,
} from "./settings";
export { BreakerOpenError, CircuitBreaker, type BreakerState, type CircuitBreakerOptions } from "./breaker";
export { createGuardedEmbedder, type GuardedEmbedder } from "./guarded";
