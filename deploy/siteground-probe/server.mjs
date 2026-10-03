// SiteGround probe for gcpe-news-platform. Every check reports ok/false plus detail; nothing here
// is destructive (the CREATE DATABASE check drops what it creates). Optional env: DATABASE_URL.
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import pg from "pg";
import { WebSocketServer } from "ws";

const started = new Date();
const ticks = { count: 0, last: null };
// Background loop like our dispatcher/publisher: if the host pauses or kills idle processes,
// `count` falls behind uptime/5 or `started` resets between visits.
setInterval(() => { ticks.count++; ticks.last = new Date().toISOString(); }, 5000);

let listenState = { ok: false, detail: "DATABASE_URL not set" };
let listenClient = null;
async function startListen() {
  if (!process.env.DATABASE_URL) return;
  try {
    listenClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listenClient.connect();
    listenClient.on("notification", (n) => { listenState = { ok: true, detail: `received '${n.payload}' at ${new Date().toISOString()}` }; });
    listenClient.on("error", (e) => { listenState = { ok: false, detail: `listen connection dropped: ${e.message}` }; });
    await listenClient.query("LISTEN gcpe_probe");
    listenState = { ok: false, detail: "listening; no notification received yet — open / again" };
  } catch (e) { listenState = { ok: false, detail: e.message }; }
}
await startListen();

const check = async (fn) => { try { return { ok: true, detail: await fn() }; } catch (e) { return { ok: false, detail: e.message }; } };

async function dbChecks() {
  if (!process.env.DATABASE_URL) return { skipped: "set DATABASE_URL to a SiteGround PostgreSQL database to run these" };
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return {
      version: await check(async () => (await c.query("select version()")).rows[0].version),
      genRandomUuid: await check(async () => (await c.query("select gen_random_uuid() as u")).rows[0].u),
      pgvector: await check(async () => { await c.query("create extension if not exists vector"); return (await c.query("select extversion from pg_extension where extname='vector'")).rows[0]?.extversion; }),
      availableVector: await check(async () => (await c.query("select name, default_version from pg_available_extensions where name in ('vector','pgcrypto')")).rows),
      advisoryLock: await check(async () => { await c.query("select pg_advisory_lock(42)"); await c.query("select pg_advisory_unlock(42)"); return "session lock acquired and released"; }),
      skipLocked: await check(async () => { await c.query("create temp table probe_q(id int)"); await c.query("insert into probe_q values (1)"); await c.query("begin"); const r = await c.query("select id from probe_q for update skip locked limit 1"); await c.query("commit"); return `claimed ${r.rowCount}`; }),
      notify: await check(async () => { await c.query("select pg_notify('gcpe_probe', $1)", [`ping ${Date.now()}`]); return "sent — LISTEN result appears under listen on the next load"; }),
      createDatabase: await check(async () => { const n = `gcpe_probe_${Date.now()}`; await c.query(`create database ${n}`); await c.query(`drop database ${n}`); return "can create separate databases (one per app)"; }),
      createSchema: await check(async () => { await c.query("create schema if not exists gcpe_probe"); await c.query("drop schema gcpe_probe"); return "can create schemas"; }),
      currentUser: await check(async () => (await c.query("select current_user, (select rolsuper from pg_roles where rolname=current_user) as superuser, (select rolcreatedb from pg_roles where rolname=current_user) as createdb")).rows[0]),
    };
  } finally { await c.end(); }
}

async function report(req) {
  return {
    node: { version: process.version, meetsRequirement: Number(process.versions.node.split(".")[0]) > 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 12) },
    process: { pid: process.pid, started: started.toISOString(), uptimeSeconds: Math.round(process.uptime()), backgroundTicks: ticks, expectedTicks: Math.floor(process.uptime() / 5) },
    host: { port: process.env.PORT ?? null, cpus: cpus().length, totalMemMb: Math.round(totalmem() / 1e6), rssMb: Math.round(process.memoryUsage().rss / 1e6), cwd: process.cwd() },
    request: { host: req.headers.host, forwardedFor: req.headers["x-forwarded-for"] ?? null, forwardedProto: req.headers["x-forwarded-proto"] ?? null },
    env: { NODE_ENV: process.env.NODE_ENV ?? null, PORT: process.env.PORT ?? null, HOST: process.env.HOST ?? null, DATABASE_URL_set: Boolean(process.env.DATABASE_URL) },
    filesystem: await check(async () => { await mkdir("probe-output/releases/x", { recursive: true }); await writeFile("probe-output/releases/x/index.html", "ok"); const v = await readFile("probe-output/releases/x/index.html", "utf8"); await rm("probe-output", { recursive: true }); return `write/read ok (${v})`; }),
    outboundHttps: await check(async () => { const r = await fetch("https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration", { signal: AbortSignal.timeout(8000) }); return `Entra metadata HTTP ${r.status}`; }),
    database: await dbChecks().catch((e) => ({ error: e.message })),
    listen: listenState,
    websocket: "open /ws-test in a browser; it reports whether a WebSocket upgrade survives SiteGround's proxy",
  };
}

const wsPage = `<!doctype html><meta charset="utf-8"><title>WS test</title><pre id="o">connecting…</pre><script>
const o=document.getElementById('o');const log=m=>o.textContent+='\\n'+m;
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
ws.onopen=()=>{log('OPEN — WebSocket upgrade works');ws.send('ping')};ws.onmessage=e=>log('echo: '+e.data);
ws.onerror=()=>log('ERROR — WebSocket blocked or failed');ws.onclose=e=>log('closed code='+e.code);
const es=new EventSource('/sse');es.onmessage=e=>{log('SSE: '+e.data);es.close()};es.onerror=()=>{log('SSE error');es.close()};
</script>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/ws-test") return res.writeHead(200, { "content-type": "text/html" }).end(wsPage);
  if (url.pathname === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    return res.end(`data: server-sent events work (${new Date().toISOString()})\n\n`);
  }
  if (url.pathname === "/") {
    try { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await report(req), null, 2)); }
    catch (e) { res.writeHead(500).end(String(e)); }
    return;
  }
  res.writeHead(404).end("not found");
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (s) => s.on("message", (m) => s.send(`pong (${m})`)));
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`[probe] listening on ${port}`));
