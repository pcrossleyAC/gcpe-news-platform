// Hand-written declaration for build-staff-web.mjs's exports — so
// tests/build-staff-web.test.ts gets real types instead of an implicit `any` (same pattern as
// scripts/build-siteground.d.mts).
export declare function assetUrlsFromMetafile(metafile: { outputs: Record<string, unknown> }): { jsPath: string; cssPath: string | undefined };
export declare function runBuild(options?: { watch?: boolean }): Promise<void>;
