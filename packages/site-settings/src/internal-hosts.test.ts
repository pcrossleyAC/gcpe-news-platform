import { describe, expect, it } from "vitest";
import { hostNameOf, internalAddressesIn, internalHostNames } from "./index";

describe("internal hosts (suite fix W2, M3)", () => {
  it("hostNameOf takes a bare name, a name with a port, or a full address, lowercased; anything else is empty", () => {
    expect(hostNameOf("gcpe-app01.internal.gov.bc.ca")).toBe("gcpe-app01.internal.gov.bc.ca");
    expect(hostNameOf(" GCPE-App01:8443 ")).toBe("gcpe-app01");
    expect(hostNameOf("https://Hub.Gov.BC.ca/hub/")).toBe("hub.gov.bc.ca");
    expect(hostNameOf("")).toBe("");
    expect(hostNameOf("not a host")).toBe("");
    expect(hostNameOf("/files/x.pdf")).toBe("");
  });

  it("internalHostNames lists each name once and never the public site's own host", () => {
    expect(internalHostNames(["gcpe-app01", "https://hub.gov.bc.ca", "GCPE-APP01:443", "", "news.gov.bc.ca"], ["https://news.gov.bc.ca", ""])).toEqual(["gcpe-app01", "hub.gov.bc.ca"]);
    // boxs.ca: the Hub and the public site share the host, so nothing on it is internal.
    expect(internalHostNames(["boxs.ca"], ["https://boxs.ca/site/"])).toEqual([]);
  });

  it("internalAddressesIn finds every http(s) address on an internal host, in plain text and in HTML", () => {
    const hosts = ["gcpe-app01", "hub.gov.bc.ca"];
    const html = '<p>See <a href="https://GCPE-APP01/files/a%20b.pdf">this</a> and <img src="http://hub.gov.bc.ca:8443/files/x.jpg"> or https://news.gov.bc.ca/files/ok.pdf.</p>';
    expect(internalAddressesIn(html, hosts)).toEqual(["https://GCPE-APP01/files/a%20b.pdf", "http://hub.gov.bc.ca:8443/files/x.jpg"]);
    expect(internalAddressesIn("https://hub.gov.bc.ca/hub/releases/1, then https://hub.gov.bc.ca/hub/releases/1", hosts)).toEqual(["https://hub.gov.bc.ca/hub/releases/1"]);
    expect(internalAddressesIn("/files/x.pdf", hosts)).toEqual([]);
    expect(internalAddressesIn("https://hub.gov.bc.ca.evil.example/x", hosts)).toEqual([]);
    expect(internalAddressesIn("https://gcpe-app01/x", [])).toEqual([]);
  });
});
