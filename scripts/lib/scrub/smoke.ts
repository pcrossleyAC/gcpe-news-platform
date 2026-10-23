import { setTimeout as sleep } from "node:timers/promises";
import { addDays } from "./dates";

export interface SmokeCheck { name: string; ok: boolean; detail: string }

export async function loginWithPassword(base: string, email: string, password: string, f: typeof fetch = fetch): Promise<string> {
  const res = await f(`${base}/core/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-gcpe-request": "1" }, body: JSON.stringify({ username: email, password }) });
  if (res.status !== 200) throw new Error(`sign-in as ${email} failed (HTTP ${res.status})`);
  const m = /gcpe_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error(`sign-in as ${email} returned no session`);
  return m[0];
}

export async function stackHealthy(base: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${base}/stack/health`);
    if (r.status !== 200) return false;
    return ((await r.json()) as { status?: string }).status === "ok";
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => Promise<boolean>, o: { timeoutMs: number; everyMs: number }): Promise<boolean> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(o.everyMs);
  }
}

export async function runSmoke(o: { base: string; calendarCookie: string; releaseCookie: string; today: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): Promise<SmokeCheck[]> {
  const f = o.fetch ?? fetch;
  const checks: SmokeCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try { checks.push({ name, ok: true, detail: await fn() }); } catch (e) { checks.push({ name, ok: false, detail: e instanceof Error ? e.message : "error" }); }
  };
  const cal = { cookie: o.calendarCookie };
  const rel = { cookie: o.releaseCookie };
  const expectOk = (r: Response) => { if (r.status !== 200) throw new Error(`HTTP ${r.status}`); };

  await step("calendar list", async () => {
    const r = await f(`${o.base}/calendar/api/list?q=${encodeURIComponent("{}")}`, { headers: cal });
    expectOk(r);
    const total = ((await r.json()) as { total: number }).total;
    if (!(total > 0)) throw new Error("the list is empty");
    return `${total} activities`;
  });
  await step("look ahead pdf", async () => {
    const start = await f(`${o.base}/calendar/api/reports/look-ahead`, { method: "POST", headers: { ...cal, "content-type": "application/json", "x-gcpe-request": "1" }, body: JSON.stringify({ q: { filter: { from: o.today, to: addDays(o.today, 6) } } }) });
    if (start.status !== 201 && start.status !== 202) throw new Error(`HTTP ${start.status}`);
    let job = (await start.json()) as { id: string; status: string };
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    while (job.status === "running") {
      if (Date.now() > deadline) throw new Error("the report timed out");
      await sleep(o.pollMs ?? 1000);
      job = (await (await f(`${o.base}/calendar/api/reports/jobs/${job.id}`, { headers: cal })).json()) as typeof job;
    }
    if (job.status !== "ready") throw new Error(`the report ${job.status}`);
    const pdf = await f(`${o.base}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: cal });
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    if (pdf.status !== 200 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("not a PDF");
    return `${bytes.length} bytes`;
  });
  await step("open a release", async () => {
    const list = await f(`${o.base}/nrms/api/releases?folder=published&pageSize=1`, { headers: rel });
    expectOk(list);
    const first = ((await list.json()) as { items: { id: string }[] }).items[0];
    if (!first) throw new Error("no published release");
    expectOk(await f(`${o.base}/nrms/api/releases/${first.id}`, { headers: rel }));
    return "opened";
  });
  await step("public home page", async () => {
    const r = await f(`${o.base}/site/`);
    expectOk(r);
    if (!(await r.text()).includes("<html")) throw new Error("not an HTML page");
    return "ok";
  });
  return checks;
}
