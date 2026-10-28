import type { ContactsPageSettings, DirectoryContact } from "@gcpe/site-settings";
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, contact, ministry, site } from "../../test/fixtures";
import { commContact, directoryContact } from "./comm-contact";
import { renderContactsPage } from "./contacts";

const row = (over: Partial<DirectoryContact>): DirectoryContact => ({ group: "", groupUrl: "", subgroup: "", name: "", phone: "", cell: "", email: "", placement: "top", ...over });

/** BC's page text with two fictional, role-level top rows (P4-R2) beside BC's bottom Premier row. */
function page(over: Partial<ContactsPageSettings> = {}): ContactsPageSettings {
  const bc = bcSettings().contactsPage;
  return {
    ...bc,
    contacts: [
      row({ group: "Media Relations", subgroup: "Language Media", name: "Language Media Desk", cell: "250-555-0110", email: "Language.Media@gov.example" }),
      row({ group: "Regional Media", name: "Regional Media Desk", phone: "250-555-0120", email: "Regional.Media@gov.example" }),
      ...bc.contacts,
    ],
    ...over,
  };
}

const primary = (name: string) => contact({ fullName: name, phoneNumber: "250-555-0100", emailAddress: `${name.replace(/\W/g, ".")}@gov.example` });

const ministries = [
  ministry({ key: "health", name: "Health", ministerName: "Hon. Alex Example", contactUser: primary("Health Desk") }),
  // A child listed before its parent in API order: it moves under the parent.
  ministry({ key: "trade", name: "Trade", parentMinistryKey: "finance", ministerName: "Hon. Robin Example", contactUser: primary("Trade Desk") }),
  ministry({ key: "finance", name: "Finance", ministerName: "Hon. Casey Example", contactUser: primary("Finance Desk") }),
  // A child whose parent isn't listed keeps its place.
  ministry({ key: "orphan", name: "Orphan Office", parentMinistryKey: "gone", ministerName: "", contactUser: primary("Orphan Desk") }),
];

const render = (ms = ministries, cp = page(), s = site) => expectAccessibleStructure(renderContactsPage(ms, cp, s, { settings: bcSettings() }));
const orgs = (doc: Document) => [...doc.querySelectorAll(".contact-row .contact-org")];
const orgName = (el: Element) => el.querySelector("a, span")?.textContent;

describe("Media Contacts page (/contacts/)", () => {
  it("one h1 (heading); the intro keeps its links and the 24-hour number; no target=_blank", () => {
    const doc = render();
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Government Communications and Public Engagement"]);
    expect(doc.querySelector(".comm-contacts > h1.comm-contacts-title + div.clear")).not.toBeNull();
    const headers = [...doc.querySelectorAll(".comm-contacts > .header")];
    expect(headers.map((h) => h.querySelector("h2")?.textContent)).toEqual(["24 hours Media Relations Contact Line", "Contact List for Media"]);
    const intro = headers[0]!.querySelector(".row > .col")!;
    expect(intro.textContent).toContain("250-883-2951");
    expect([...intro.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["ministry’s", "Service BC"]);
    expect(doc.querySelectorAll("[target]")).toHaveLength(0);
  });

  it("rows in order: two top settings rows, ministries in API order with children after their parent (.child), the bottom Premier row", () => {
    const doc = render();
    expect(orgs(doc).map(orgName)).toEqual(["Media Relations", "Regional Media", "Health", "Finance", "Trade", "Orphan Office", "Office of the Premier"]);
    expect(orgs(doc).map((o) => o.classList.contains("child"))).toEqual([false, false, false, false, true, false, false]);
    // A ministry links to its page; a settings row links to a safe groupUrl (base path added), else is a span.
    const s = { ...site, baseUrl: "https://boxs.example/site" };
    const based = render(ministries, page(), s);
    const links = orgs(based).map((o) => o.querySelector("a")?.getAttribute("href") ?? null);
    expect(links).toEqual([null, null, "/site/ministries/health/", "/site/ministries/finance/", "/site/ministries/trade/", "/site/ministries/orphan/", "/site/ministries/office-of-the-premier/"]);
    expect(orgs(doc)[0]!.querySelector("span")?.textContent).toBe("Media Relations");
    expect([...orgs(doc)[0]!.querySelectorAll("div")].map((d) => d.textContent)).toEqual(["Language Media"]);
    expect([...orgs(doc)[2]!.querySelectorAll("div")].map((d) => d.textContent)).toEqual(["Hon. Alex Example"]);
    // The settings contact maps onto the CommContact shape.
    const premier = doc.querySelectorAll(".contact-row")[6]!;
    expect(premier.querySelector(".contact-name")?.textContent).toBe("Media Line");
    expect(premier.querySelector('a[href^="mailto:"]')?.getAttribute("href")).toBe("mailto:Premier.Media@gov.bc.ca");
  });

  it("a groupUrl that isn't safe renders the group as text", () => {
    const doc = render([], page({ contacts: [row({ group: "Evil", groupUrl: "javascript:alert(1)", name: "Desk" })] }));
    expect(orgs(doc)[0]!.querySelector("a")).toBeNull();
    expect(orgs(doc)[0]!.querySelector("span")?.textContent).toBe("Evil");
  });

  it("a ministry without contactUser, or inactive, is left out; a blank ministerName adds no empty div", () => {
    const doc = render([
      ministry({ key: "a", name: "No Contact", contactUser: null, secondContactUser: primary("Alt Only") }),
      ministry({ key: "b", name: "Inactive", isActive: false, contactUser: primary("B Desk") }),
      ministry({ key: "c", name: "Empty Contact", contactUser: contact({}) }),
      ministry({ key: "d", name: "Blank Minister", ministerName: "  ", contactUser: primary("D Desk") }),
    ], page({ contacts: [] }));
    expect(orgs(doc).map(orgName)).toEqual(["Blank Minister"]);
    expect(orgs(doc)[0]!.querySelectorAll("div")).toHaveLength(0);
  });

  it("contact with phone only shows Direct: and no <br>; cell only shows Cell:; a bad email renders as text", () => {
    const phoneOnly = commContact(contact({ fullName: "A", phoneNumber: "250-555-0100" }));
    expect(phoneOnly).toContain("<div><span>Direct: 250-555-0100</span></div>");
    expect(phoneOnly).not.toContain("Cell:");
    const cellOnly = commContact(contact({ fullName: "B", mobileNumber: "250-555-0101" }));
    expect(cellOnly).toContain("<div><span>Cell: 250-555-0101</span></div>");
    expect(cellOnly).not.toContain("Direct:");
    expect(commContact(contact({ fullName: "C", phoneNumber: "1", mobileNumber: "2" }))).toContain("<span>Direct: 1</span><br><span>Cell: 2</span>");
    const bad = commContact(contact({ fullName: "D", emailAddress: "d example@gov.example" }));
    expect(bad).not.toContain("mailto:");
    expect(bad).toContain("d example@gov.example");
    expect(commContact(contact({ emailAddress: "e@gov.example" }))).toContain('<a href="mailto:e@gov.example">e@gov.example</a>');
    // A settings contact with no phone or email: the name alone, no empty Direct:/Cell: div.
    const nameOnly = commContact(directoryContact(row({ group: "G", name: "Desk" })));
    expect(nameOnly).toBe('<span class="contact-name">Desk</span>');
    expect(directoryContact(row({ name: "N", phone: "1", cell: "", email: "" }))).toEqual({ fullName: "N", phoneNumber: "1", mobileNumber: null, emailAddress: null });
  });

  it("after hours row only with weekendContactNumber; displayAdditionalName in brackets and italics", () => {
    const doc = render(
      [
        ministry({ key: "a", name: "A", contactUser: primary("A Desk"), weekendContactNumber: "250-555-0199", displayAdditionalName: "Formerly <B>" }),
        ministry({ key: "b", name: "B", contactUser: primary("B Desk"), weekendContactNumber: " " }),
      ],
      page({ contacts: [] }),
    );
    const [a, b] = [...doc.querySelectorAll(".contact-row")];
    const after = a!.querySelector(":scope > .text-center.after-hours > div > span")!;
    expect(after.querySelector("strong")?.textContent).toBe("After hours:");
    expect(after.textContent?.replace(/\s+/g, " ").trim()).toBe("After hours: 250-555-0199");
    expect(b!.querySelector(".after-hours")).toBeNull();
    const extra = a!.querySelector(".contact-org > div > i");
    expect(extra?.textContent).toBe("(Formerly <B>)");
    expect(b!.querySelector(".contact-org i")).toBeNull();
  });

  it("the alternate contact gets its own cell only when present", () => {
    const doc = render([ministry({ key: "a", name: "A", contactUser: primary("A Desk"), secondContactUser: primary("A Alt") })], page({ contacts: [] }));
    const cells = [...doc.querySelectorAll(".contact-row > .col-xs-12.col-sm-4:not(.contact-org)")];
    expect(cells.map((c) => c.querySelector(".contact-name")?.textContent)).toEqual(["A Desk", "A Alt"]);
    expect(render([ministry({ key: "a", name: "A", contactUser: primary("A Desk") })], page({ contacts: [] })).querySelectorAll(".contact-row > div")).toHaveLength(2);
  });

  it("introHtml with <script>, <iframe>, onclick and <h1> renders one h1 and none of them", () => {
    const html = renderContactsPage(
      [],
      page({ introHtml: '<h1>Intro</h1><p onclick="x()">Hi <img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a></p><script>alert(1)</script><iframe src="https://evil.example"></iframe>' }),
      site,
      { settings: bcSettings() },
    );
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const intro = doc.querySelector(".comm-contacts .header .col")!;
    expect(intro.querySelector("h2")?.textContent).toBe("Intro");
    expect(intro.innerHTML).not.toMatch(/script|iframe|onclick|onerror|javascript:|<img/i);
    expect(intro.textContent).toContain("bad");
  });

  it("a blank lineHeading emits no empty h2", () => {
    const doc = render([], page({ lineHeading: "" }));
    expect([...doc.querySelectorAll(".comm-contacts h2")].map((h) => h.textContent)).toEqual(["Contact List for Media"]);
  });

  it("each contact cell carries a visually-hidden Primary/Alternate label; the column header row is aria-hidden", () => {
    const doc = render([ministry({ key: "a", name: "A", contactUser: primary("A Desk"), secondContactUser: primary("A Alt") })], page({ contacts: [] }));
    const labels = [...doc.querySelectorAll(".contact-row .visually-hidden")].map((s) => s.textContent);
    expect(labels).toEqual(["Primary contact: ", "Alternate contact: "]);
    const columns = doc.querySelector(".row.d-none.d-md-flex.contact-columns")!;
    expect(columns.getAttribute("aria-hidden")).toBe("true");
    expect([...columns.querySelectorAll(":scope > div.col")].map((c) => c.textContent)).toEqual(["", "Primary Contact", "Alternate Contact"]);
  });

  it("canonical URL is /contacts/ under the base path", () => {
    const doc = render(ministries, page(), { ...site, baseUrl: "https://boxs.example/site" });
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://boxs.example/site/contacts/");
  });
});
