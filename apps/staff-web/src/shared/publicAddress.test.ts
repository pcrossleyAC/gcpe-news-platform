import { describe, expect, it } from "vitest";
import { STAFF_HOST_WARNING, checkHubAddress, publicFileUrl, publicFilesOrigin, staffHostWarning } from "./publicAddress";

const INTERNAL = "https://gcpe-app01.internal.gov.bc.ca";

describe("W1: public addresses for Website files", () => {
  it("a link built on an internal Hub host still points at the public base", () => {
    const origin = publicFilesOrigin({ filesBase: "https://news.gov.bc.ca", publicSiteUrl: "https://news.gov.bc.ca" });
    expect(publicFileUrl("/files/report%20one.pdf", origin, INTERNAL)).toBe("https://news.gov.bc.ca/files/report%20one.pdf");
  });

  it("takes the files base first, then the public site URL's origin (a prefixed site URL keeps only its origin)", () => {
    expect(publicFilesOrigin({ filesBase: "https://files.example.ca/", publicSiteUrl: "https://news.example.ca" })).toBe("https://files.example.ca");
    expect(publicFilesOrigin({ filesBase: "", publicSiteUrl: "https://boxs.ca/site/" })).toBe("https://boxs.ca");
    expect(publicFilesOrigin({})).toBe("");
    expect(publicFilesOrigin({ filesBase: "not a url" })).toBe("");
  });

  it("with no public base configured, falls back to the page's own origin", () => {
    expect(publicFileUrl("/files/a.pdf", "", "http://localhost:4600")).toBe("http://localhost:4600/files/a.pdf");
  });

  it("warns about an address on the Hub's own host only when the public site lives elsewhere", () => {
    const hub = "gcpe-app01.internal.gov.bc.ca";
    expect(staffHostWarning(`${INTERNAL}/files/minister.jpg`, "https://news.gov.bc.ca", hub)).toBe(STAFF_HOST_WARNING);
    expect(staffHostWarning(" https://gcpe-app01.internal.gov.bc.ca/files/x ", "https://news.gov.bc.ca", hub)).toBe(STAFF_HOST_WARNING);
    expect(staffHostWarning("https://news.gov.bc.ca/files/minister.jpg", "https://news.gov.bc.ca", hub)).toBeNull();
    // A test site where the Hub and the public site share a host: the address works for the public.
    expect(staffHostWarning("https://boxs.ca/files/x.jpg", "https://boxs.ca", "boxs.ca")).toBeNull();
    // Unknown public origin, blank, or not an address: no warning.
    expect(staffHostWarning(`${INTERNAL}/files/x`, "", hub)).toBeNull();
    expect(staffHostWarning("", "https://news.gov.bc.ca", hub)).toBeNull();
    expect(staffHostWarning("/files/x.jpg", "https://news.gov.bc.ca", hub)).toBeNull();
  });

  it("I4: a Hub /files/ address becomes the public one; any other Hub address keeps its text and a warning", () => {
    const hub = "gcpe-app01.internal.gov.bc.ca";
    expect(checkHubAddress(`${INTERNAL}/files/a%20b.pdf?x=1#p2`, "https://news.gov.bc.ca", hub)).toEqual({ url: "https://news.gov.bc.ca/files/a%20b.pdf?x=1#p2", warning: null });
    expect(checkHubAddress(`${INTERNAL}/hub/releases/1`, "https://news.gov.bc.ca", hub)).toEqual({ url: `${INTERNAL}/hub/releases/1`, warning: STAFF_HOST_WARNING });
    expect(checkHubAddress("https://youtu.be/x", "https://news.gov.bc.ca", hub)).toEqual({ url: "https://youtu.be/x", warning: null });
    expect(checkHubAddress(`${INTERNAL}/files/a.pdf`, "", hub)).toEqual({ url: `${INTERNAL}/files/a.pdf`, warning: null });
  });
});
