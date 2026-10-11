import { describe, expect, it } from "vitest";
import { REPORT_STORE_MAX_BYTES, ReportJobNotFoundError, ReportJobs } from "./jobs";
import type { ReportDoc } from "./model";
import type { PdfRenderer } from "./render/renderer";

const doc = (title: string): ReportDoc => ({ page: "letter-portrait", title, header: null, footer: null, blocks: [] });
const MB = 1024 * 1024;

describe("finished reports held in memory", () => {
  it(`past ${REPORT_STORE_MAX_BYTES / MB} MB the oldest finished PDF goes first, its owner gets 404, and a running report is never dropped`, async () => {
    const held: (() => void)[] = [];
    const renderer: PdfRenderer = {
      async render(d) {
        if (d.title === "Sample held") await new Promise<void>((resolve) => held.push(resolve));
        return new Uint8Array(20 * MB);
      },
      close: async () => {},
    };
    let clock = 1_000;
    const jobs = new ReportJobs({ renderer, concurrency: 2, now: () => clock });
    const run = async (owner: string, title: string) => {
      const { id } = jobs.start(owner, "planning", doc(title));
      clock += 1_000;
      return { owner, id, view: await jobs.settle(owner, id, 1_000) };
    };
    const [a, b, c] = [await run("owner-a", "Sample A"), await run("owner-b", "Sample B"), await run("owner-c", "Sample C")];
    // 60 MB held: all three kept.
    for (const j of [a, b, c]) expect(jobs.pdf(j.owner, j.id).bytes.byteLength).toBe(20 * MB);
    const running = jobs.start("owner-r", "planning", doc("Sample held"));
    const d = await run("owner-d", "Sample D");
    expect(d.view.status).toBe("ready");
    // 80 MB would be past the store: A, the oldest, is gone.
    expect(() => jobs.view(a.owner, a.id)).toThrow(ReportJobNotFoundError);
    for (const j of [b, c, d]) expect(jobs.pdf(j.owner, j.id).bytes.byteLength).toBe(20 * MB);
    expect(jobs.view("owner-r", running.id).status).toBe("running");
    held.forEach((f) => f());
    await jobs.settle("owner-r", running.id, 1_000);
    await jobs.close();
  });
});
