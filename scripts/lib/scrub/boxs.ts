import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { LocalApp } from "./local";
import { ScrubArgumentError, ScrubStepError } from "./private-out";

/** Where SiteGround keeps the Node app's settings. Read only inside a subshell, never printed. */
export const BOXS_ENV_FILE = "$HOME/www/boxs.ca/public_html/.nodeapp/.env-local";

export const BOXS_APPS: readonly { app: string; envVar: string; local: LocalApp; replaced: boolean }[] = [
  { app: "core", envVar: "CORE_DATABASE_URL", local: "core", replaced: true },
  { app: "nrms", envVar: "NRMS_DATABASE_URL", local: "nrms", replaced: true },
  { app: "news-api", envVar: "NEWSAPI_DATABASE_URL", local: "newsApi", replaced: true },
  { app: "site", envVar: "SITE_DATABASE_URL", local: "site", replaced: true },
  { app: "calendar", envVar: "CALENDAR_DATABASE_URL", local: "calendar", replaced: true },
  { app: "nod", envVar: "NOD_DATABASE_URL", local: "nod", replaced: false },
  { app: "distribution", envVar: "DIST_DATABASE_URL", local: "distribution", replaced: false },
];
export const STAMP_RE = /^\d{8}-\d{6}$/;

const stampOk = (stamp: string) => { if (!STAMP_RE.test(stamp)) throw new ScrubArgumentError("a stamp is YYYYMMDD-HHMMSS"); return stamp; };
const appOf = (name: string) => { const a = BOXS_APPS.find((x) => x.app === name); if (!a) throw new ScrubArgumentError("unknown app"); return a; };

const PRELUDE = [
  "set -euo pipefail",
  "umask 077",
  `ENV_FILE="${BOXS_ENV_FILE}"`,
  '[ -r "$ENV_FILE" ] || { echo "cannot read the stack settings file" >&2; exit 1; }',
  'url_of() { ( set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a; v="${!1:-}"; [ -n "$v" ] || { echo "$1 is not set" >&2; exit 1; }; printf "%s" "$v" ); }',
].join("\n");

/**
 * Drops what this database's own user owns: tables, views, sequences, types, functions and any
 * schema other than public and the system ones. On boxs.ca `public` belongs to another role; on a
 * local superuser it doesn't, and neither does information_schema, so both are excluded by name.
 */
export const DROP_MINE_SQL = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = current_user AND n.nspname NOT IN ('public', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname);
  END LOOP;
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE', CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.relname);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) = current_user LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) = current_user AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid) LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user LOOP
    EXECUTE 'DROP ROUTINE IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;
`;

/** Lines a plain dump may carry about the shared `public` schema, which boxs.ca's user doesn't own. */
export const DUMP_FILTER_SED = ["-e", "/^COMMENT ON SCHEMA public IS /d", "-e", "/^CREATE SCHEMA public;$/d", "-e", "/^ALTER SCHEMA public OWNER TO /d"];

export function unsafeDumpLine(line: string): string | null {
  if (/^CREATE EXTENSION /.test(line)) return "an extension boxs.ca can't create";
  if (/^\\connect\b/.test(line)) return "a \\connect to another database";
  return null;
}

export function testAccountsScript(): string {
  const q = "WITH a AS (SELECT * FROM users WHERE password_hash IS NOT NULL OR entra_oid IS NOT NULL) SELECT json_build_object("
    + "'users', coalesce((SELECT json_agg(json_build_object('id', id, 'email', email, 'display_name', display_name, 'is_active', is_active, 'sign_in_method', sign_in_method, 'password_hash', password_hash, 'entra_oid', entra_oid, 'created_at', created_at, 'updated_at', updated_at) ORDER BY email) FROM a), '[]'::json), "
    + "'roleGrants', coalesce((SELECT json_agg(json_build_object('user_id', g.user_id, 'role', g.role, 'granted_at', g.granted_at) ORDER BY g.user_id, g.role) FROM role_grants g JOIN a ON a.id = g.user_id), '[]'::json), "
    + "'memberships', coalesce((SELECT json_agg(json_build_object('user_id', uo.user_id, 'org_key', o.key, 'org_abbreviation', o.abbreviation) ORDER BY uo.user_id, o.key) FROM user_organizations uo JOIN a ON a.id = uo.user_id JOIN organizations o ON o.id = uo.organization_id), '[]'::json))";
  return [PRELUDE, `psql "$(url_of CORE_DATABASE_URL)" -X -A -t -q -v ON_ERROR_STOP=1 -c "${q}"`, ""].join("\n");
}

export function backupScript(stamp: string): string {
  stampOk(stamp);
  return [
    PRELUDE,
    `DIR="$HOME/gcpe-data/backups/${stamp}"`,
    'mkdir -p "$DIR"',
    `for pair in ${BOXS_APPS.map((a) => `${a.app}:${a.envVar}`).join(" ")}; do`,
    '  app="${pair%%:*}"; var="${pair#*:}"',
    '  pg_dump --format=plain --no-owner --no-acl --dbname="$(url_of "$var")" | gzip > "$DIR/$app.sql.gz"',
    '  echo "dumped $app"',
    "done",
    'tar -C "$HOME/gcpe-data" -czf "$DIR/site-output.tar.gz" site-output',
    'echo "backup size (KB): $(du -sk "$DIR" | cut -f1)"',
    "",
  ].join("\n");
}

export function restoreScript(o: { stamp: string; from: "scrub-load" | "backups"; apps: string[]; resetNodPositions: boolean; siteOutput: "clear" | "restore" }): string {
  stampOk(o.stamp);
  const apps = o.apps.map(appOf);
  const sed = DUMP_FILTER_SED.map((x) => `'${x}'`).join(" ");
  return [
    PRELUDE,
    `SRC="$HOME/gcpe-data/${o.from}/${o.stamp}"`,
    'DROP_SQL="$(mktemp)"',
    "trap 'rm -f \"$DROP_SQL\"' EXIT",
    "cat > \"$DROP_SQL\" <<'DROPSQL'",
    DROP_MINE_SQL.trimEnd(),
    "DROPSQL",
    "restore_one() {",
    '  local app="$1" var="$2" u',
    '  u="$(url_of "$var")"',
    '  [ -s "$SRC/$app.sql.gz" ] || { echo "missing $app.sql.gz" >&2; exit 1; }',
    `  { cat "$DROP_SQL"; gunzip -c "$SRC/$app.sql.gz" | sed ${sed}; } | psql "$u" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null`,
    '  echo "restored $app"',
    "}",
    ...apps.map((a) => `restore_one ${a.app} ${a.envVar}`),
    ...(o.resetNodPositions ? [`psql "$(url_of NOD_DATABASE_URL)" -X -q -v ON_ERROR_STOP=1 -c "DELETE FROM inbox_positions WHERE source IN ('core', 'nrms')" >/dev/null`, 'echo "cleared NoD positions for core and nrms"'] : []),
    ...(o.siteOutput === "clear"
      ? ['mkdir -p "$HOME/gcpe-data/site-output"', 'find "$HOME/gcpe-data/site-output" -mindepth 1 -delete', 'echo "cleared site-output: the site rebuilds on start"']
      : ['[ -s "$SRC/site-output.tar.gz" ] || { echo "missing site-output.tar.gz" >&2; exit 1; }', 'rm -rf "$HOME/gcpe-data/site-output"', 'tar -C "$HOME/gcpe-data" -xzf "$SRC/site-output.tar.gz"', 'echo "restored site-output"']),
    "",
  ].join("\n");
}

export function tickScript(site: string, times: number): string {
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(site)) throw new ScrubArgumentError("--site must be an https origin");
  return [PRELUDE, `for i in $(seq 1 ${Math.max(1, Math.trunc(times))}); do`, `  curl -fsS -X POST -H "Authorization: Bearer $(cat "$HOME/.gcpe-tick-token")" "${site}/stack/tick" >/dev/null`, "  sleep 5", "done", 'echo "ticked"', ""].join("\n");
}

export async function runRemote(host: string, script: string, o: { capture?: boolean } = {}): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", host, "bash", "-s"], { stdio: ["pipe", o.capture ? "pipe" : "inherit", "inherit"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res(out) : rej(new ScrubStepError(`a step on ${host} failed (exit ${code})`))));
    child.stdin!.end(script);
  });
}

export async function uploadFile(host: string, localPath: string, stamp: string, name: string): Promise<void> {
  stampOk(stamp);
  if (!/^[a-z-]+\.sql\.gz$/.test(name)) throw new ScrubArgumentError("upload names are <app>.sql.gz");
  const child = spawn("ssh", ["-o", "BatchMode=yes", host, `umask 077; mkdir -p "$HOME/gcpe-data/scrub-load/${stamp}" && cat > "$HOME/gcpe-data/scrub-load/${stamp}/${name}"`], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`uploading ${name} failed (exit ${code})`)))); });
  await pipeline(createReadStream(localPath), child.stdin!);
  await done;
}

export async function downloadBackup(host: string, stamp: string, localFile: string): Promise<void> {
  stampOk(stamp);
  mkdirSync(dirname(localFile), { recursive: true, mode: 0o700 });
  const child = spawn("ssh", ["-o", "BatchMode=yes", host, `tar -C "$HOME/gcpe-data/backups" -cf - ${stamp}`], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`downloading the backup failed (exit ${code})`)))); });
  await pipeline(child.stdout!, createWriteStream(localFile, { mode: 0o600 }));
  await done;
}

/** A plain-SQL dump, gzipped, after checking it holds nothing boxs.ca's user can't restore. */
export async function localDump(url: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
  const child = spawn("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--dbname=${url}`], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`pg_dump failed (exit ${code})`)))); });
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(outFile, { mode: 0o600 }));
  for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
    const why = unsafeDumpLine(line);
    if (why) { child.kill(); gzip.destroy(); throw new ScrubStepError(`the dump holds ${why}`); }
    if (!gzip.write(`${line}\n`)) await new Promise((r) => gzip.once("drain", r));
  }
  gzip.end();
  await Promise.all([done, written]);
}
