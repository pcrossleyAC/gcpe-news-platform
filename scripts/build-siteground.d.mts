// Hand-written declaration for build-siteground.mjs's exported, pure(ish) functions — so
// tests/build-siteground-guard.test.ts gets real types instead of an implicit `any`.
export declare function findLeakedPaths(dir: string, forbidden: { label: string; value: string }[]): { file: string; label: string }[];
export declare function copyStaffWebToHub(staffWebDistDir: string, outDir: string): void;
export declare function assertHubBuilt(outDir: string): void;
