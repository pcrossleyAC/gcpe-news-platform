// Hand-written declaration for build-siteground.mjs's one exported, pure function — so
// tests/build-siteground-guard.test.ts gets real types instead of an implicit `any`.
export declare function findLeakedPaths(dir: string, forbidden: { label: string; value: string }[]): { file: string; label: string }[];
