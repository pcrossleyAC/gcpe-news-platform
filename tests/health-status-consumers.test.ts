// Suite review O2.1 (owner 2026-10-31): /stack/health now answers status "degraded" (still HTTP 200)
// when every app is up but a background check is red, such as an undelivered update. A deploy or
// smoke check that waits for "ok" alone would then roll back a good release over a backlog, so every
// script that waits on the health check must accept "degraded" too, and only "unavailable" (or no
// answer) fails it. These text checks fail the ordinary test run if one drifts back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("scripts that wait on /stack/health accept degraded", () => {
  it("Wait-GcpeHealth (Windows deploys and imports)", () => {
    const fn = /function Wait-GcpeHealth \{[\s\S]*?\n\}/.exec(read("deploy/windows/lib/Gcpe.psm1"))?.[0] ?? "";
    expect(fn).toMatch(/\$json\.status -in @\('ok', 'degraded'\)/);
    expect(fn).not.toMatch(/\$json\.status -eq 'ok'/);
  });

  it("the OpenShift smoke test", () => {
    const smoke = read("deploy/openshift/smoke-test.sh");
    expect(smoke).toContain(`grep -Eq '"status":"(ok|degraded)"'`);
    expect(smoke).not.toContain(`grep -q '"status":"ok"'`);
  });

  it("the Windows CI workflow", () => {
    const wf = read(".github/workflows/windows.yml");
    expect(wf).not.toMatch(/\$health\.status -(eq|ne) 'ok'/);
    expect(wf.match(/\$health\.status -(not)?in @\('ok', 'degraded'\)/g)?.length ?? 0).toBe(3);
  });
});
