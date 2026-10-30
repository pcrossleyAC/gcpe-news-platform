// Hand-written declarations for manuals-lib.mjs, for the TypeScript tests (and the staff-web typecheck).
export interface ManualHeader {
  id: string;
  title: string;
  manual: string;
  order: number;
  routes: string[];
  screens: string[];
  topics: string[];
}
export interface ManualPage extends ManualHeader {
  markdown: string;
  html: string;
  hash: string;
  changed: string;
  previous: { html: string; changed: string } | null;
}
export interface ManualsData {
  pages: ManualPage[];
}
export interface PageSource {
  path: string;
  text: string;
}
export declare const MANUAL_IDS: string[];
export declare function parsePage(path: string, text: string): { header: ManualHeader; body: string };
export declare function renderMarkdown(markdown: string): string;
export declare function compile(pages: PageSource[], previousData: ManualsData | null, today: string): ManualsData;
export declare function readManualPages(dir?: string): PageSource[];
export declare function vancouverToday(now?: Date): string;
export declare function plainLanguageProblems(body: string): string[];
