import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/siteground-website-walkthrough.sh";

describe("scripts/siteground-website-walkthrough.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", SCRIPT]);
  });

  it("sends the CSRF header, keeps the cookie jar private, and sets the cleanup trap before mktemp creates it", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toContain("x-gcpe-request: 1");
    expect(s).toMatch(/umask 077/);
    const lines = s.split("\n");
    const trapLine = lines.findIndex((l) => /trap cleanup EXIT/.test(l));
    const mktempLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    expect(trapLine).toBeGreaterThanOrEqual(0);
    expect(mktempLine).toBeGreaterThan(trapLine);
  });

  it("never passes the admin password to another process as a command-line argument, and unsets it right after use", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    for (const line of lines) {
      expect(line).not.toMatch(/python3[^|]*"\$(ADMIN_PASS|pass)"/);
      expect(line).not.toMatch(/\bjson\b[^|]*"\$(ADMIN_PASS|pass)"/);
    }
    expect(s).toMatch(/unset ADMIN_PASS/);
  });

  it("refuses to run against anything but a test site, before signing in or touching anything else", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    const noindexCheckLine = lines.findIndex((l) => l.includes("has no noindex meta"));
    const jarLine = lines.findIndex((l) => /JAR="\$\(mktemp\)"/.test(l));
    const loginLine = lines.findIndex((l) => l.includes('"$BASE/core/auth/login"'));
    expect(noindexCheckLine).toBeGreaterThanOrEqual(0);
    expect(noindexCheckLine).toBeLessThan(jarLine);
    expect(noindexCheckLine).toBeLessThan(loginLine);
  });

  it("turns Project Blue Bridge off and unpins the primary slide in the cleanup trap, re-reading each one's current version", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const cleanupFn = s.slice(s.indexOf("cleanup() {"), s.indexOf("trap cleanup EXIT"));
    expect(cleanupFn.length).toBeGreaterThan(0);
    expect(cleanupFn).toMatch(/"on":False/);
    expect(cleanupFn).toMatch(/"pinned":False/);
    expect(cleanupFn).toContain("/nrms/api/site/blue-bridge");
    expect(cleanupFn).toContain("/nrms/api/site/pins/primary/pinned");
    // Re-reads the version rather than reusing a variable set earlier in the run.
    expect(cleanupFn).toMatch(/CUR_V=/);
    expect(cleanupFn).toMatch(/PV=/);
  });

  it("generates the test PDF in-script with a minimal valid %PDF- header, never fetching one from the network", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toMatch(/%PDF-1\.4/);
    expect(s).toMatch(/PDF_FILE="\$\(mktemp\)"/);
  });

  it("every mutating control call (POST/PUT) uses curl -f or explicitly checks its result (not a bare `|| true`)", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    // The logout call is deliberately exempt: it's genuinely best-effort (failing to log out
    // isn't worth a WARNING), which is exactly what its own `|| true` says.
    const mutating = lines.filter((l) => /curl_(api|bin)\b.*-X (POST|PUT)/.test(l) && !l.includes("auth/logout"));
    expect(mutating.length).toBeGreaterThanOrEqual(10);
    for (const l of mutating) {
      const hasDashF = /(^|\s)-f(\s|$)/.test(l);
      // I3: `|| true` unconditionally swallows a failure without even a warning — it must not
      // count as "checking status". A real check is either `-w '%{http_code}'` (read elsewhere
      // in the script and compared) or a `||` fallback that actually does something (e.g. an
      // `echo "...WARNING..."`).
      const checksStatus = l.includes("-w '%{http_code}'") || (/\|\|/.test(l) && !/\|\|\s*true\b/.test(l));
      expect(hasDashF || checksStatus).toBe(true);
    }
  });

  // I3: cleanup's PUT/POST calls must capture and branch on the real HTTP status — a bare
  // `curl ... || echo WARNING` never fires on a non-2xx response (curl itself still exits 0
  // having received one), so the warning would silently never print on exactly the responses
  // (409/403/422) that matter.
  it("cleanup's Blue Bridge/pin/Live Feed/links calls check the real HTTP status, not just curl's own exit code", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const cleanupFn = s.slice(s.indexOf("cleanup() {"), s.indexOf("trap cleanup EXIT"));
    const statusChecks = cleanupFn.match(/-w '%\{http_code\}'/g) ?? [];
    expect(statusChecks.length).toBeGreaterThanOrEqual(4); // Blue Bridge, pin, Live Feed, links
    expect(cleanupFn).toMatch(/case "\$OFF_STATUS" in/);
    expect(cleanupFn).toMatch(/case "\$UNPIN_STATUS" in/);
    expect(cleanupFn).toMatch(/case "\$LF_STATUS" in/);
    expect(cleanupFn).toMatch(/case "\$LINKS_STATUS" in/);
  });

  // I3: BB_ON/PIN_ON must be set to 1 *before* the request that turns the thing on is sent —
  // not after confirming it succeeded — so a client-side timeout that happened after the
  // server actually committed the change still triggers cleanup.
  it("sets BB_ON=1 and PIN_ON=1 before sending the request that turns each one on", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    const bbOnAssign = lines.findIndex((l) => /^BB_ON=1$/.test(l.trim()));
    const bbPut = lines.findIndex((l) => l.includes('curl_api -f -X PUT "$BASE/nrms/api/site/blue-bridge" -d "$BB_ON_BODY"'));
    const pinOnAssign = lines.findIndex((l) => /^PIN_ON=1$/.test(l.trim()));
    const pinPost = lines.findIndex((l) => l.includes('-X POST "$BASE/nrms/api/site/pins/primary/pinned" -d "$PINNED_BODY"'));
    expect(bbOnAssign).toBeGreaterThanOrEqual(0);
    expect(bbOnAssign).toBeLessThan(bbPut);
    expect(pinOnAssign).toBeGreaterThanOrEqual(0);
    expect(pinOnAssign).toBeLessThan(pinPost);
  });

  it("uploads the test PDF with replace=false first, retrying with replace=true only on a 409 conflict", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    // Matched against the actual curl invocations (the URL query string), not the explanatory
    // comment above them, which mentions both words too.
    const falseLine = lines.findIndex((l) => l.includes("name=website-walkthrough.pdf&replace=false"));
    const checkLine = lines.findIndex((l) => l.includes('"$UPLOAD_STATUS" = "409"'));
    const trueLine = lines.findIndex((l) => l.includes("name=website-walkthrough.pdf&replace=true"));
    const genericCase = lines.findIndex((l) => l.includes('case "$UPLOAD_STATUS" in'));
    expect(falseLine).toBeGreaterThanOrEqual(0);
    expect(checkLine).toBeGreaterThan(falseLine);
    expect(trueLine).toBeGreaterThan(checkLine);
    expect(genericCase).toBeGreaterThan(trueLine); // any other non-2xx still fails, after the retry
  });

  // Minor 7: Live Feed and resource links are restored to their prior state on exit; the
  // carousel switch-over is deliberately left in place (documented, not restored).
  it("restores the Live Feed and resource links on exit; documents that the carousel switch-over is left in place", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toMatch(/LIVE_FEED_TOUCHED=1/);
    expect(s).toMatch(/LINKS_TOUCHED=1/);
    expect(s).toMatch(/PRIOR_LIVE_FEED_ENABLED/);
    expect(s).toMatch(/PRIOR_LINKS_JSON/);
    expect(s).toMatch(/does NOT undo[\s\S]*carousel/);
  });

  // Minor 7: /api/Slides can carry inlined base64 image data (I4) — must go to python via
  // stdin, never as a command-line argument.
  it("pipes the /api/Slides JSON to python via stdin, not as a command-line argument", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const lines = s.split("\n");
    const pollPython = s.slice(s.indexOf("for i in $(seq"), s.indexOf("[ \"$ready\" = \"1\" ]"));
    expect(pollPython).toMatch(/printf '%s' "\$SLIDES_JSON" \| python3/);
    expect(pollPython).not.toMatch(/sys\.argv\[1\]\)\s*\n\s*slides = json\.loads\(sys\.argv/);
    for (const l of lines) {
      // SLIDES_JSON must never appear as a quoted argv element passed to python3.
      expect(l).not.toMatch(/python3[^|]*"\$SLIDES_JSON"/);
    }
  });

  it("exits non-zero when the expected end state is never reached, and polls once a minute up to 6 times", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toMatch(/set -euo pipefail/);
    expect(s).toMatch(/FAILED: never reached the expected state/);
    expect(s).toMatch(/POLL_INTERVAL="\$\{POLL_INTERVAL:-60\}"/);
    expect(s).toMatch(/MAX_POLLS="\$\{MAX_POLLS:-6\}"/);
  });

  it("checks the public site for the TEST banner and noindex after turning Project Blue Bridge on", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s).toContain("TEST — ALERT:");
    const lines = s.split("\n");
    const bbOnLine = lines.findIndex((l) => l.includes('"on":True,"confirmation"'));
    const bannerCheckLine = lines.findIndex((l) => l.includes("TEST — ALERT:"));
    expect(bbOnLine).toBeGreaterThanOrEqual(0);
    expect(bannerCheckLine).toBeGreaterThan(bbOnLine);
  });
});
