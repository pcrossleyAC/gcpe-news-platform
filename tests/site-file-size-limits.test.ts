import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_SITE_FILE_BYTES } from "../apps/nrms/src/website/files";

// Owner decision 2026-10-29: Hub site files of any type, up to 512 MiB. Every layer in front of
// the app has to let that through, or an upload fails with an HTML 413 (or a gateway timeout)
// before NRMS sees it.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("site-file size limits agree across layers", () => {
  it("the app server's IIS request limit clears MAX_SITE_FILE_BYTES (512 MiB)", () => {
    expect(MAX_SITE_FILE_BYTES).toBe(512 * 1024 * 1024);
    const m = /<requestLimits maxAllowedContentLength="(\d+)" \/>/.exec(read("deploy/windows/Install-Gcpe.ps1"));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(MAX_SITE_FILE_BYTES);
    // IIS's limit is a uint: at most 4 GiB - 1.
    expect(Number(m![1])).toBeLessThan(2 ** 32);
  });

  it("ARR's proxy timeout leaves time for a 512 MiB upload on a slow link (at least 20 minutes)", () => {
    const m = /system\.webServer\/proxy[^\n]*\/timeout:"(\d\d):(\d\d):(\d\d)"/.exec(read("deploy/windows/Install-Gcpe.ps1"));
    expect(m).not.toBeNull();
    const minutes = Number(m![1]) * 60 + Number(m![2]);
    expect(minutes).toBeGreaterThanOrEqual(20);
  });

  it("the DMZ proxy still refuses large bodies: staff uploads never go through it", () => {
    const m = /<requestLimits maxAllowedContentLength="(\d+)" \/>/.exec(read("deploy/windows/Install-GcpeProxy.ps1"));
    expect(Number(m![1])).toBeLessThanOrEqual(1024 * 1024);
  });

  it("the deploy guides state the 512 MB site-file limit", () => {
    expect(read("docs/deploy/windows.md")).toMatch(/512 MB/);
    expect(read("docs/deploy/siteground.md")).toMatch(/site files?[^.]*512 MB|512 MB[^.]*site file/i);
  });
});
