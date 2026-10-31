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
/** A page as the Hub ships it: without the markdown or the previous version. */
export type HubManualPage = Omit<ManualPage, "markdown" | "previous">;
export interface HubManualsData {
  pages: HubManualPage[];
}
/** Each page id's previous version, as the review screen loads it. */
export type ManualPreviousVersions = Record<string, ManualPage["previous"]>;
export interface PageSource {
  path: string;
  text: string;
}
export declare const MANUAL_IDS: string[];
export declare function parsePage(path: string, text: string): { header: ManualHeader; body: string };
export declare function renderMarkdown(markdown: string, resolve?: ((target: string) => string) | null): string;
export declare function compile(pages: PageSource[], previousData: ManualsData | null, today: string): ManualsData;
export declare function splitForHub(data: ManualsData): { hub: HubManualsData; previous: ManualPreviousVersions };
export declare function readManualPages(dir?: string): PageSource[];
export declare function vancouverToday(now?: Date): string;
export declare function plainLanguageProblems(body: string): string[];
export declare function safeTarget(href: string): boolean;
