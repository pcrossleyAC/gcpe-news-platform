// Generates the stack's environment file for a Windows Server deployment (docs/deploy/windows.md).
// deploy/windows/Install-Gcpe.ps1 runs the bundled copy (tools/windows-env.js in the package) once,
// on first install, piping a JSON object on stdin and writing stdout to <root>\config\gcpe.env,
// which the Windows service hands to Node with --env-file.
//
// Every internal secret (TICK_TOKEN, LOCAL_AUTH_SECRET, STACK_EVENT_SECRET) is generated here
// with crypto.randomBytes, as scripts/siteground-env.ts does; the admin password arrives raw and
// leaves only as its scrypt hash. This mode is for test sites (Dev): local admin stays on as the
// break-glass login, and SITE_ENVIRONMENT=test marks the deployment as not the real production one.
//
// `--event-subscribers <PREFIX>` instead prints that app's EVENT_SUBSCRIBERS exactly as the running
// stack derives them from the STACK_EVENT_SECRET in its own environment, for the legacy importers:
// the outbox rows they write are delivered by the stack's dispatcher, which matches them by name.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hashPassword } from "../packages/auth/src/password";
import { parseJsonQuietly } from "./windows-json";
import { GOOGLE_SITE_VERIFICATION_RE, GOOGLE_VERIFICATION_FILE_RE } from "../apps/public-site/src/verification";
import { APP_PREFIXES, eventRoutesFor, internalEventEnv, type AppPrefix } from "../apps/stack/src/env";

// Not imported from ./siteground-env: bundled into one file, that module's own entry-point guard
// would match this bundle's path too and run its interactive prompt alongside this tool.
export interface GeneratedSecrets {
  tickToken: string;
  localAuthSecret: string;
  stackEventSecret: string;
}

const secret = (): string => randomBytes(32).toString("hex");
export const generateSecrets = (): GeneratedSecrets => ({ tickToken: secret(), localAuthSecret: secret(), stackEventSecret: secret() });

/** Every app prefix needs its own AUTH_AUDIENCE once ENTRA_TENANT_ID is set. */
const AUDIENCE_PREFIXES = APP_PREFIXES;

const DB_NAMES: Record<AppPrefix, string> = {
  CORE: "core",
  NRMS: "nrms",
  NEWSAPI: "news_api",
  SITE: "site",
  NOD: "nod",
  DIST: "distribution",
  CALENDAR: "calendar",
};

// A value Node's --env-file and the installer's own reader both take literally: no line breaks,
// and not both quote characters (one of them is needed to quote the value).
const envValue = z
  .string()
  .refine((v) => !/[\r\n]/.test(v), "must not contain a line break")
  .refine((v) => !(v.includes("'") && v.includes('"')), "must not contain both ' and \"");

export const windowsEnvInputSchema = z
  .object({
    hostName: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "must be a host name such as news-dev.example.gov.bc.ca"),
    dataDir: envValue.refine((v) => /^[A-Za-z]:\\/.test(v), "must be an absolute Windows path such as D:\\gcpe\\data"),
    port: z.number().int().min(1024).max(65535),
    adminUsername: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    adminPassword: z.string().min(12, "the admin password must be at least 12 characters"),
    db: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      user: z.string().regex(/^[a-z_][a-z0-9_]*$/),
      password: z.string().min(1),
      prefix: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    }),
    smtp: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: envValue.optional(),
      pass: envValue.optional(),
    }),
    // Reverse proxies in front of this server (TRUST_PROXY_HOPS): 1 normally, 2 behind a DMZ proxy.
    proxyHops: z.number().int().min(1).max(5).optional(),
    mailFrom: z.string().email(),
    // A test site always redirects every message (docs/deploy/siteground.md, "Mailbox / SMTP").
    mailRedirectTo: z.array(z.string().email()).min(1, "a test site must redirect mail: give at least one mailRedirectTo address"),
    entra: z
      .object({
        tenantId: z.string().uuid(),
        clientId: z.string().uuid(),
        clientSecret: envValue.pipe(z.string().min(1)),
        audience: envValue.pipe(z.string().min(1)),
      })
      .optional(),
    // Google Search Console verification (url-compat §1d), optional: set when this host is the
    // one Search Console should verify. Same token shapes the public site enforces at startup.
    googleVerificationFile: z.string().regex(GOOGLE_VERIFICATION_FILE_RE, "must look like google<16 hex>.html").optional(),
    googleSiteVerification: z.string().regex(GOOGLE_SITE_VERIFICATION_RE, "must be 20-100 letters, digits, - or _").optional(),
  })
  .strict();

export type WindowsEnvInput = z.infer<typeof windowsEnvInputSchema>;

/** Writes `KEY=value`, single-quoting a value with anything but plain URL/path characters. */
export function envLine(key: string, value: string): string {
  if (/^[A-Za-z0-9_\-.:/@%+=,~$]*$/.test(value)) return `${key}=${value}`;
  return value.includes("'") ? `${key}="${value}"` : `${key}='${value}'`;
}

function dbUrl(db: WindowsEnvInput["db"], name: string): string {
  return `postgres://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.prefix}_${name}`;
}

/** Pure: every line of the env file, from validated input, a precomputed hash and secrets. */
export function buildWindowsEnvLines(input: WindowsEnvInput, adminPasswordHash: string, secrets: GeneratedSecrets): string[] {
  const origin = `https://${input.hostName}`;
  const lines = [
    "# Generated by tools/windows-env.js (scripts/windows-env.ts) on first install. Holds secrets:",
    "# readable only by Administrators and the gcpe-stack service account.",
    "NODE_ENV=production",
    "SITE_ENVIRONMENT=test",
    envLine("PORT", String(input.port)),
    envLine("DATA_DIR", input.dataDir),
    envLine("TRUST_PROXY_HOPS", String(input.proxyHops ?? 1)),
    "STACK_LOOPS=true",
    "UPDATES_HUB_ENABLED=true",
    envLine("TICK_TOKEN", secrets.tickToken),
    "",
    "LOCAL_ADMIN_ENABLED=true",
    "LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true",
    envLine("LOCAL_ADMIN_USERNAME", input.adminUsername),
    envLine("LOCAL_ADMIN_PASSWORD_HASH", adminPasswordHash),
    envLine("LOCAL_AUTH_SECRET", secrets.localAuthSecret),
    envLine("STACK_EVENT_SECRET", secrets.stackEventSecret),
    "",
    ...Object.entries(DB_NAMES).map(([prefix, name]) => envLine(`${prefix}_DATABASE_URL`, dbUrl(input.db, name))),
    "",
    "SITE_NEWS_API_URL=self:/",
    "SITE_OUTPUT_DIR=./site-output",
    envLine("SITE_PUBLIC_SITE_URL", origin),
    ...(input.googleVerificationFile ? [envLine("SITE_GOOGLE_VERIFICATION_FILE", input.googleVerificationFile)] : []),
    ...(input.googleSiteVerification ? [envLine("SITE_GOOGLE_SITE_VERIFICATION", input.googleSiteVerification)] : []),
    "NOD_DISTRIBUTION_URL=self:/distribution",
    envLine("NOD_PUBLIC_SITE_URL", origin),
    "",
    envLine("DIST_SMTP_HOST", input.smtp.host),
    envLine("DIST_SMTP_PORT", String(input.smtp.port)),
    envLine("DIST_SMTP_SECURE", String(input.smtp.secure)),
    ...(input.smtp.user ? [envLine("DIST_SMTP_USER", input.smtp.user)] : []),
    ...(input.smtp.pass ? [envLine("DIST_SMTP_PASS", input.smtp.pass)] : []),
    envLine("DIST_MAIL_FROM", input.mailFrom),
    envLine("DIST_MAIL_REDIRECT_TO", input.mailRedirectTo.join(",")),
  ];
  if (input.entra) {
    lines.push(
      "",
      envLine("ENTRA_TENANT_ID", input.entra.tenantId),
      envLine("CORE_ENTRA_CLIENT_ID", input.entra.clientId),
      envLine("CORE_ENTRA_CLIENT_SECRET", input.entra.clientSecret),
      envLine("CORE_PUBLIC_BASE_URL", origin),
      ...AUDIENCE_PREFIXES.map((p) => envLine(`${p}_AUTH_AUDIENCE`, input.entra!.audience)),
    );
  }
  return lines;
}

/** One app's EVENT_SUBSCRIBERS as the stack derives them, with `self:` resolved as the stack does. */
export function eventSubscribersFor(prefix: string, env: NodeJS.ProcessEnv): string {
  if (!(APP_PREFIXES as readonly string[]).includes(prefix)) throw new Error(`unknown app prefix ${prefix}`);
  if (!env.STACK_EVENT_SECRET) throw new Error("STACK_EVENT_SECRET is not set");
  const json = internalEventEnv(env.STACK_EVENT_SECRET, eventRoutesFor(env))[prefix as AppPrefix].EVENT_SUBSCRIBERS ?? "[]";
  const origin = `http://127.0.0.1:${env.PORT ?? "3000"}`;
  const subscribers = (JSON.parse(json) as { url: string }[]).map((s) => ({ ...s, url: s.url.startsWith("self:") ? origin + s.url.slice("self:".length) : s.url }));
  return JSON.stringify(subscribers);
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--event-subscribers");
  if (at !== -1) {
    process.stdout.write(eventSubscribersFor(process.argv[at + 1] ?? "", process.env) + "\n");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const parsed = windowsEnvInputSchema.safeParse(parseJsonQuietly(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success) {
    // Name the field and the rule, never the value: the input carries passwords.
    for (const issue of parsed.error.issues) console.error(`windows-env: ${issue.path.join(".") || "(input)"}: ${issue.message}`);
    process.exit(1);
  }
  const lines = buildWindowsEnvLines(parsed.data, await hashPassword(parsed.data.adminPassword), generateSecrets());
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  await main().catch((e: unknown) => {
    console.error(`windows-env: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
