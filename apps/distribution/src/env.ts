import { fileURLToPath } from "node:url";
import { z } from "zod";

// z.coerce.boolean() treats the string "false" as truthy (any non-empty string coerces to
// true), so booleans are parsed from an explicit enum instead.
const boolEnv = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const commaList = (def = "") =>
  z
    .string()
    .default(def)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

// MAIL_REDIRECT_TO entries must themselves be valid addresses: a typo here (e.g. "qa@") would
// otherwise silently become an unroutable "to" address at send time instead of failing at boot.
const emailList = commaList().pipe(z.array(z.string().email()));

/**
 * The domain nodemailer's `messageId` (and MESSAGE_ID_DOMAIN, when unset) is derived from:
 * MAIL_FROM may be a bare address ("news@example.com") or an RFC 5322 "Name <address>" form.
 * Returns undefined for a value with no "@" at all, so startup can fail rather than produce a
 * domain-less Message-ID.
 */
function domainFromMailFrom(mailFrom: string): string | undefined {
  const angleBracket = mailFrom.match(/<([^>]+)>/);
  const address = angleBracket ? angleBracket[1]! : mailFrom;
  const at = address.lastIndexOf("@");
  if (at === -1) return undefined;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

export const distributionEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3005),
    // Phase 4e: Distribution's own outbox (recordBounce's delivery.bounced, dispatched by the
    // tick's "dispatch" worker) — same shape and default as every other sending app (Core,
    // NRMS). Distribution never receives events, so there's no EVENT_SECRETS here.
    EVENT_SUBSCRIBERS: z.string().optional(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: boolEnv("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_TLS_REJECT_UNAUTHORIZED: boolEnv("true"),
    // Worst-case time a single message's send may take before nodemailer gives up: used both
    // to configure the transport (main.ts) and, summed, as sender.ts's default perMessageMs
    // for sizing the claim lock (see sender.ts's defaultSendLockMs).
    SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    SMTP_GREETING_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    SMTP_MAX_CONNECTIONS: z.coerce.number().int().positive().default(3),
    // R1: how long sender.ts's transport.verify() is given, on a config-class error, to
    // decide whether the SMTP server itself is reachable before concluding the message is to
    // blame (a "poison message" that stalls/resets mid-DATA, not an outage). Counted per
    // message in the claim lock and the stop margin (sender.ts's defaultSendLockMs).
    SMTP_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MAIL_FROM: z.string().min(1),
    MAIL_REDIRECT_TO: emailList,
    MAIL_ALLOW_REAL_RECIPIENTS: boolEnv("false"),
    // Distribution's own Reply-To, used when a request doesn't carry its own (messages.ts's
    // replyTo); redirect mode leaves this unchanged.
    MAIL_REPLY_TO: z.string().email().optional(),
    // The domain of every outgoing message's Message-ID (messageIdFor in sender.ts). Defaults
    // to MAIL_FROM's own domain — see domainFromMailFrom and the superRefine below, which fails
    // startup if neither yields one.
    MESSAGE_ID_DOMAIN: z.string().min(1).optional(),
    // R1(b): the age backstop — a message pending longer than this is marked failed and
    // logged no matter what kind of error it's been hitting.
    MAIL_MAX_AGE_MS: z.coerce.number().int().positive().default(24 * 3_600_000),
    // Legacy's configured core domains (CommonMethods.cs's ExchangeMailDomains) — recipients
    // here get priority.ts's +2 bump by default.
    INTERNAL_DOMAINS: commaList("gov.bc.ca,leg.bc.ca"),
    // C58/spec §6: the database-enforced per-minute send cap (sender.ts), shared across every
    // worker through send_rate_windows. Minimum 1 — no "unlimited" value, so a typo can't
    // remove the cap.
    MAIL_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(60),
    // The number of sendMail calls sender.ts keeps in flight at once within a single run.
    // Bounded by SMTP_MAX_CONNECTIONS below (the transport can't actually serve more
    // concurrent sends than it has pooled connections for) and by 16 as a sanity ceiling.
    MAIL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
    SEND_INTERVAL_MS: z.coerce.number().int().default(2000),
    // P2-R27: longest pause after an SMTP outage deferral (sender.ts startSender) — bounds how
    // long sending takes to resume once the server is back.
    SEND_OUTAGE_COOLDOWN_MAX_MS: z.coerce.number().int().positive().default(300_000),
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    // 4e: which bounce source start.ts wires up (bounces/source.ts's fakeBounceSource, or
    // bounces/graph.ts's graphBounceSource) — "fake" on test sites/dev, "graph" once Q23 is
    // answered (docs/parity/open-questions.md). The superRefine below refuses to boot in
    // "graph" mode without every one of the four GRAPH_*/BOUNCE_MAILBOX variables below.
    BOUNCE_SOURCE: z.enum(["fake", "graph"]).default("fake"),
    GRAPH_TENANT_ID: z.string().min(1).optional(),
    GRAPH_CLIENT_ID: z.string().min(1).optional(),
    GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
    BOUNCE_MAILBOX: z.string().email().optional(),
  })
  .superRefine((e, ctx) => {
    // Non-prod mail redirect safety rule: refuse to boot unless either a redirect list is
    // configured or someone has explicitly opted in to delivering to real recipients. When
    // both are set, the redirect wins at send time (sender.ts only consults MAIL_REDIRECT_TO).
    if (e.MAIL_REDIRECT_TO.length === 0 && !e.MAIL_ALLOW_REAL_RECIPIENTS) {
      ctx.addIssue({ code: "custom", message: "set MAIL_REDIRECT_TO or MAIL_ALLOW_REAL_RECIPIENTS=true" });
    }
    // The transport can't actually run more sends in parallel than it has pooled connections
    // for — refuse to boot rather than silently serialise behind MAIL_CONCURRENCY's intent.
    if (e.MAIL_CONCURRENCY > e.SMTP_MAX_CONNECTIONS) {
      ctx.addIssue({
        code: "custom",
        message: `MAIL_CONCURRENCY (${e.MAIL_CONCURRENCY}) must not exceed SMTP_MAX_CONNECTIONS (${e.SMTP_MAX_CONNECTIONS})`,
        path: ["MAIL_CONCURRENCY"],
      });
    }
    // Global Constraints "Bounce source": refuse to boot in Graph mode without everything the
    // Graph reader needs — a half-configured Graph source would otherwise only fail once the
    // bounce run actually tries to fetch a token, far from this env check.
    if (e.BOUNCE_SOURCE === "graph") {
      for (const key of ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "BOUNCE_MAILBOX"] as const) {
        if (!e[key]) ctx.addIssue({ code: "custom", message: `${key} is required when BOUNCE_SOURCE=graph`, path: [key] });
      }
    }
  })
  // Resolves MESSAGE_ID_DOMAIN once at startup, rather than re-deriving it from MAIL_FROM on
  // every send: an explicit value always wins, otherwise MAIL_FROM's own domain is used, and
  // startup fails if neither yields one.
  .transform((e, ctx) => {
    const domain = e.MESSAGE_ID_DOMAIN ?? domainFromMailFrom(e.MAIL_FROM);
    if (domain === undefined) {
      ctx.addIssue({ code: "custom", message: "set MESSAGE_ID_DOMAIN, or give MAIL_FROM a domain (e.g. \"news@example.com\")", path: ["MESSAGE_ID_DOMAIN"] });
    }
    return { ...e, MESSAGE_ID_DOMAIN: domain ?? "" };
  });

export type DistributionEnv = z.infer<typeof distributionEnvSchema>;
