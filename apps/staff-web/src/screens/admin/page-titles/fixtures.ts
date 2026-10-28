/** Shared by PageTitlesScreen's tests and the admin axe test. */
export const PAGE_IMAGES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "BC logo", sortOrder: 1, mimeType: "image/png", altTexts: { "4105": "BC" } },
];

const row = (releaseType: string, pageTitle: string, languageId: number, sortOrder: number, layout = "formal", pageImageId: string | null = null) => ({
  releaseType, pageTitle, languageId, sortOrder, layout, pageImageId,
});

export const PageTypesFixture = [
  row("release", "News Release", 4105, 1),
  row("release", "Information Bulletin", 4105, 2),
  row("release", "Communiqué", 3084, 6),
  row("story", "Story", 4105, 1, "informal"),
];
