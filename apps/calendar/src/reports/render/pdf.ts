import { readFileSync } from "node:fs";
import { join } from "node:path";
import pdfmake from "pdfmake";
import type { ReportDoc } from "../model";
import { BC_SANS_FILES, loadBcSans } from "./fonts";
import { docDefinitionOf, FONT, imagesOf } from "./layout";

/** pdfmake's in-memory file store; its server build has one, though its types don't say so. */
const store = (pdfmake as unknown as { virtualfs: { writeFileSync(name: string, data: Buffer): void; existsSync(name: string): boolean } }).virtualfs;

/** A tenant's image name: a bare file name, never a path (packages/config's schema says the same). */
export const IMAGE_NAME = /^[\w-]+(\.[\w-]+)*\.(jpe?g|png)$/i;

let images: string | null = null;

/**
 * Embeds BC Sans, and stops pdfmake from fetching anything: a report names no URL or file, so a
 * document that tried would be refused rather than reach the network or the disk. Images come only
 * from `imagesDir`, read here into pdfmake's in-memory store when a document first names them.
 */
export function useBcSans(fontsDir: string, imagesDir: string | null = null): void {
  const faces = loadBcSans(fontsDir);
  for (const [style, bytes] of Object.entries(faces)) store.writeFileSync(BC_SANS_FILES[style as keyof typeof BC_SANS_FILES], bytes);
  pdfmake.setFonts({ [FONT]: { ...BC_SANS_FILES } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  images = imagesDir;
}

function storeImages(doc: ReportDoc): void {
  for (const name of imagesOf(doc)) {
    if (!IMAGE_NAME.test(name)) throw new Error("not an image name");
    if (store.existsSync(name)) continue;
    if (images === null) throw new Error("no images folder");
    store.writeFileSync(name, readFileSync(join(images, name)));
  }
}

/** Lays out and writes one report. Synchronous work: run it in a worker, never on a request's thread. */
export async function renderPdf(doc: ReportDoc): Promise<Uint8Array<ArrayBuffer>> {
  storeImages(doc);
  const buf = await pdfmake.createPdf(docDefinitionOf(doc)).getBuffer();
  // A copy of its own, so it can be transferred out of the worker (a pooled Buffer can't be).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
