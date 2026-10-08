import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

/** Peak resident memory of a process tree we can see: this process, and a child Chromium by pid (Linux /proc). */
function childPeakMb(pid) {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null; // macOS: no /proc; the report notes `ps -o rss` sampled by hand instead
  }
}

export async function measure(label, fn, { chromiumPid = null } = {}) {
  global.gc?.();
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  const pages = out.kind === "pdf" ? (await PDFDocument.load(out.bytes)).getPageCount() : null;
  return {
    label,
    ms,
    bytes: out.bytes.length,
    pages,
    nodePeakMb: Math.round(process.resourceUsage().maxRSS / 1024),
    chromiumPeakMb: chromiumPid ? childPeakMb(chromiumPid) : null,
  };
}
