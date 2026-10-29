import { z } from "zod";
import { fileURLToPath } from "node:url";
import { eventSecretsSchema } from "@gcpe/config";
import { embeddingsEnvShape, refineEmbeddingsEnv } from "@gcpe/embeddings";

export const newsApiEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3002),
    TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
    EVENT_SECRETS: eventSecretsSchema,
    EVENT_SUBSCRIBERS: z.string().optional(),
    NOD_BASE_URL: z.string().url().optional(),
    NOD_TOKEN_URL: z.string().url().optional(),
    NOD_CLIENT_ID: z.string().optional(),
    NOD_CLIENT_SECRET: z.string().optional(),
    NOD_SCOPE: z.string().optional(),
    SUBSCRIBE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
    ONE_CLICK_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(6000),
    SUBSCRIBE_CLIENT_IP_HEADER: z.string().min(1).optional(),
    UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
    UPDATES_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5000),
    UPDATES_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(50),
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    /** Search results link to `<PUBLIC_SITE_URL>/releases/<key>`. Default: the tenant's publicSiteBaseUrl. */
    PUBLIC_SITE_URL: z.string().url().optional(),
    /** Cosine distance at or below which a post is a semantic match (spec §5.4). */
    SEARCH_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(2).default(0.6),
    /** Requests a minute per client IP on /api/v2/search (Q74), keyed like Subscribe. */
    SEARCH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    /** Public search results are kept in memory this long (0 turns the cache off). Matches the
     * public site's max-age: a publish shows in search within this time. */
    SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    SEARCH_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(500),
    SEARCH_CACHE_MAX_MB: z.coerce.number().int().min(1).max(1024).default(32),
    /** Vector scans running at once. Unset: max(2, CPU cores - 1). */
    SEARCH_SEMANTIC_MAX_CONCURRENT: z.coerce.number().int().min(1).max(256).optional(),
    /** Semantic queries allowed to wait for a slot, and for how long, before falling back to text. */
    SEARCH_SEMANTIC_QUEUE: z.coerce.number().int().min(0).max(1000).default(8),
    SEARCH_SEMANTIC_QUEUE_WAIT_MS: z.coerce.number().int().min(0).max(5000).default(250),
    /** Where a slide event's imageKey is fetched from (addendum §6.4) — required: the fetch
     * never falls back to the event's own imageUrl (that has no host allow-list), so without
     * this the News API can't safely fetch slide images at all, and refuses to start. The
     * stack sets this to its own self:/files (SiteGround can't loop back to its public
     * origin); a standalone deployment points it at a route that reaches NRMS's files (Q85). */
    SLIDE_IMAGES_FETCH_BASE: z.string().url(),
    ...embeddingsEnvShape,
  })
  .superRefine(refineEmbeddingsEnv);

export type NewsApiEnv = z.infer<typeof newsApiEnvSchema>;
