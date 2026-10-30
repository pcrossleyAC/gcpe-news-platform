// Hand-written declarations for manuals-docx.mjs, for the TypeScript tests.
import type { ManualsData } from "./manuals-lib.mjs";
export declare const LOGO_PATH: string;
export declare function buildManualDocx(data: ManualsData, manualId: string, opts: { logoPath: string; versionDate: string }): Promise<Buffer>;
export declare function writeAllDocx(outDir: string, data?: ManualsData): Promise<string[]>;
