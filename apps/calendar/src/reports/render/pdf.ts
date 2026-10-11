import pdfmake from "pdfmake";
import type { ReportDoc } from "../model";
import { BC_SANS_FILES, loadBcSans } from "./fonts";
import { docDefinitionOf, FONT } from "./layout";

/** pdfmake's in-memory file store; its server build has one, though its types don't say so. */
const store = (pdfmake as unknown as { virtualfs: { writeFileSync(name: string, data: Buffer): void } }).virtualfs;

/**
 * Embeds BC Sans, and stops pdfmake from fetching anything: a report names no URL or file, so a
 * document that tried would be refused rather than reach the network or the disk.
 */
export function useBcSans(fontsDir: string): void {
  const faces = loadBcSans(fontsDir);
  for (const [style, bytes] of Object.entries(faces)) store.writeFileSync(BC_SANS_FILES[style as keyof typeof BC_SANS_FILES], bytes);
  pdfmake.setFonts({ [FONT]: { ...BC_SANS_FILES } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
}

/** Lays out and writes one report. Synchronous work: run it in a worker, never on a request's thread. */
export async function renderPdf(doc: ReportDoc): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await pdfmake.createPdf(docDefinitionOf(doc)).getBuffer();
  // A copy of its own, so it can be transferred out of the worker (a pooled Buffer can't be).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
