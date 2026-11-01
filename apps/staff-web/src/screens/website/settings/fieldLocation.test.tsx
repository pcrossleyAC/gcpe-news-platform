import { describe, expect, it } from "vitest";
import { settingsFieldLocation } from "./fieldLocation";

describe("settingsFieldLocation (suite fix W2, fix round 1 M2)", () => {
  it.each([
    ["banner", ["message"], "Message"],
    ["banner", ["links", 1, "url"], "Links, link 2: Web address"],
    ["footer", ["helpLinks", 0, "url"], "Help links, link 1: Web address"],
    ["footer", ["moreInfoLinks", 2, "text"], "More Info links, link 3: Link text"],
    ["footer", ["helpText"], "Help text"],
    ["connect", ["policyLink", "url"], "Policy link URL"],
    ["connect", ["intro"], "Introduction"],
    ["connect", ["youtube", "featured", 0, "summary"], "YouTube: Featured accounts, link 1: Description (optional)"],
    ["connect", ["x", "accounts", 3, "url"], "X: Other accounts, link 4: Web address"],
    ["ministryPages", ["ministryWebsite"], "Ministry website heading"],
    ["contactsPage", ["introHtml"], "Introduction"],
    ["contactsPage", ["contacts", 4, "groupUrl"], "Other media contacts, contact 5: Group link"],
    ["pageText", ["subscribeHelpHtml"], "Subscribe page: Help line"],
    ["pageText", ["privacy", "bodyHtml"], "Privacy page: Statement"],
    ["pageText", ["assetLicence", "url"], "Media assets licence: Link URL"],
    ["pageText", ["searchArchiveLinks", 0, "url"], "Search: older archives, link 1: Web address"],
    ["navigation", ["headerLinks", 1, "url"], "Header links, link 2: Web address"],
    ["navigation", ["labels", "resources"], expect.any(String)],
    ["navigation", ["listingTitles", "stories"], "Stories page title"],
    ["siteIdentity", ["blueBridge", "message"], "Project Blue Bridge banner: Banner message"],
  ] as const)("%s %j is %s", (section, path, label) => {
    expect(settingsFieldLocation(section, [...path])).toEqual(label);
  });

  it("names a page label by its field on screen, and an unknown place as nothing rather than a code name", () => {
    expect(settingsFieldLocation("navigation", ["labels", "resources"])).not.toMatch(/resources$/);
    expect(settingsFieldLocation("pageText", ["somethingNew"])).toBe("");
    expect(settingsFieldLocation("footer", [])).toBe("");
  });
});
