import { z } from "zod";
import { isRealProduction } from "@gcpe/config";
import { azureOpenAiProvider } from "./azure-openai";
import type { EmbeddingProvider } from "./provider";
import { standInProvider } from "./stand-in";
import { clampTimeoutMs } from "./timeout";

export { clampTimeoutMs };

export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/**
 * Merged into an app's own env schema (the News API's), so `node stack.js --check` applies the
 * same rules a real start does. NODE_ENV, LOCAL_ADMIN_ALLOW_IN_PRODUCTION and SITE_ENVIRONMENT
 * are read only for the production guard; they are shared, unprefixed stack variables.
 */
export const embeddingsEnvShape = {
  EMBEDDINGS_PROVIDER: z.preprocess(blankToUndefined, z.enum(["azure-openai", "stand-in"]).optional()),
  EMBEDDINGS_TIMEOUT_MS: optionalString.transform((v) => clampTimeoutMs(v)),
  AZURE_OPENAI_ENDPOINT: z.preprocess(blankToUndefined, z.string().url().optional()),
  AZURE_OPENAI_API_KEY: optionalString,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: optionalString,
  AZURE_OPENAI_API_VERSION: z.preprocess(blankToUndefined, z.string().default(DEFAULT_AZURE_API_VERSION)),
  NODE_ENV: optionalString,
  LOCAL_ADMIN_ALLOW_IN_PRODUCTION: optionalString,
  SITE_ENVIRONMENT: optionalString,
};

const embeddingsEnvObject = z.object(embeddingsEnvShape);
export type EmbeddingsEnv = z.output<typeof embeddingsEnvObject>;

const AZURE_REQUIRED = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] as const;

export function refineEmbeddingsEnv(env: EmbeddingsEnv, ctx: z.RefinementCtx): void {
  if (env.EMBEDDINGS_PROVIDER === "azure-openai") {
    for (const name of AZURE_REQUIRED) {
      if (!env[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "is required when EMBEDDINGS_PROVIDER=azure-openai" });
    }
  }
  if (env.EMBEDDINGS_PROVIDER === "stand-in" && isRealProduction(env)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EMBEDDINGS_PROVIDER"],
      message:
        "stand-in is refused on a production deployment (NODE_ENV=production without LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true or SITE_ENVIRONMENT=test)",
    });
  }
}

export const embeddingsEnvSchema = embeddingsEnvObject.superRefine(refineEmbeddingsEnv);

/** The configured provider, or null: full-text only (spec §4). Call only with refined env. */
export function createEmbeddingProvider(env: EmbeddingsEnv, fetchImpl: typeof fetch = fetch): EmbeddingProvider | null {
  switch (env.EMBEDDINGS_PROVIDER) {
    case "stand-in":
      return standInProvider();
    case "azure-openai": {
      const { AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: apiKey, AZURE_OPENAI_EMBEDDING_DEPLOYMENT: deployment } = env;
      if (!endpoint || !apiKey || !deployment) throw new Error("azure-openai needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
      return azureOpenAiProvider(
        { endpoint, apiKey, deployment, apiVersion: env.AZURE_OPENAI_API_VERSION, timeoutMs: env.EMBEDDINGS_TIMEOUT_MS },
        fetchImpl,
      );
    }
    default:
      return null;
  }
}
