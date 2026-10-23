import { describe, expect, it } from "vitest";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";
import { findLeaks, plainNameHits, scrubText } from "../../scripts/lib/scrub/text";

const KEY = "d".repeat(64);
const index = buildPeopleIndex([
  { source: "calendar.SystemUser", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: ["(604) 555-0142"], alwaysPerson: true },
  { source: "calendar.GovernmentRepresentative", id: "1", names: ["Hon. Dorian Feld"], email: null, phones: [] },
  { source: "media.Contact", id: "9", names: ["José Ñúñez"], email: null, phones: [] },
  { source: "calendar.SystemUser", id: "2", names: ["Marisol Tennant-Vey"], email: null, phones: [], alwaysPerson: true },
  { source: "dbo.Ministry", id: "M1", names: ["Hon. Corin Vale, Minister of Health"], email: null, phones: [] },
  { source: "calendar.GovernmentRepresentative", id: "2", names: ["Premier Bexley Strand (Acting)"], email: null, phones: [] },
  { source: "media.Contact", id: "10", names: ["Perrin Halloways"], email: null, phones: [] },
  { source: "media.Contact", id: "11", names: ["T. Brennick"], email: null, phones: [] },
  { source: "calendar.SystemUser", id: "3", names: ["Fenna Rook Lindqvist"], email: null, phones: [], alwaysPerson: true },
  { source: "media.Contact", id: "12", names: ["J.R. Pellow"], email: null, phones: [] },
], KEY);
const ctx = { index, key: KEY };
const quill = index.bySource.get("calendar.SystemUser:1")!.fake;
const s = (t: string) => scrubText(t, ctx).text;
const fakeOf = (k: string) => index.bySource.get(k)!.fake;
const real = /\b(?:Quill|Ashbury|Dorian|Feld|Marisol|Tennant|Corin|Vale|Bexley|Strand|Perrin|Halloways|Brennick|Fenna|Rook|Lindqvist|Pellow)\b|Jos(?:e|é|&eacute;|&#233;)|N(?:u|ú|&uacute;)(?:n|ñ|&ntilde;)ez/i;

describe("names", () => {
  it("replaces a full name inside a sentence", () => expect(s("Met with Quill Ashbury today.")).toBe(`Met with ${quill.first} ${quill.last} today.`));
  it("keeps capitals", () => expect(s("QUILL ASHBURY")).toBe(`${quill.first.toUpperCase()} ${quill.last.toUpperCase()}`));
  it("matches across a line break", () => expect(s("Quill\nAshbury")).toBe(`${quill.first}\n${quill.last}`));
  it("keeps markup between name parts", () => {
    expect(s("Quill&nbsp;Ashbury")).toBe(`${quill.first}&nbsp;${quill.last}`);
    expect(s("<b>Quill</b> <i>Ashbury</i>")).toBe(`<b>${quill.first}</b> <i>${quill.last}</i>`);
    expect(s("<p>Quill Ashbury&#8217;s team</p>")).toBe(`<p>${quill.first} ${quill.last}&#8217;s team</p>`);
    expect(s("Quill &amp; Ashbury")).toBe("Quill &amp; Ashbury");
  });
  it("handles the surname-first form", () => expect(s("Ashbury, Quill said")).toBe(`${quill.last}, ${quill.first} said`));
  it("keeps possessives", () => {
    expect(s("Quill Ashbury's plan")).toBe(`${quill.first} ${quill.last}'s plan`);
    expect(s("Quill Ashbury’s plan")).toBe(`${quill.first} ${quill.last}’s plan`);
  });
  it("leaves an honorific and replaces the person", () => expect(s("Hon. Dorian Feld spoke")).not.toMatch(/Dorian|Feld/));
  it("ignores accents and case", () => expect(s("with jose nunez")).not.toMatch(/jose|nunez/i));
  it("matches hyphenated surnames whole", () => {
    expect(s("Marisol Tennant-Vey")).not.toMatch(/Marisol/);
    expect(s("Marisol Tennant arrived")).toBe("Marisol Tennant arrived");
  });
  it("matches whole words only", () => {
    expect(s("Quillon Ashbury")).toBe("Quillon Ashbury");
    expect(s("Quill Ashburyton")).toBe("Quill Ashburyton");
  });
  it("gives the same person the same name everywhere", () => expect(s("Quill Ashbury and Ashbury, Quill")).toBe(`${quill.first} ${quill.last} and ${quill.last}, ${quill.first}`));
});

describe("names inside tags", () => {
  it("replaces names in attribute values and leaves the markup alone", () => {
    expect(s('<img src="a.png" alt="Quill Ashbury at the podium">')).toBe(`<img src="a.png" alt="${quill.first} ${quill.last} at the podium">`);
    expect(s("<a title='Ashbury, Quill' href=\"/x\">Read</a>")).toBe(`<a title='${quill.last}, ${quill.first}' href="/x">Read</a>`);
    expect(s('<img alt="Quill" title="Ashbury">')).toBe('<img alt="Quill" title="Ashbury">');
  });
  it("still joins name parts across a tag that has attributes", () => expect(s('Quill <img alt="x"> Ashbury')).toBe(`${quill.first} <img alt="x"> ${quill.last}`));
});

describe("names written with entities", () => {
  const jose = fakeOf("media.Contact:9");
  it.each([
    "Jos&eacute; &Ntilde;&uacute;&ntilde;ez",
    "Jos&#233; &#209;&#250;&#241;ez",
    "Jos&#xE9; &#xD1;&#xFA;&#xF1;ez",
    "José &Ntilde;úñez",
    "Jos&eacute;&nbsp;&Ntilde;&uacute;&ntilde;ez",
  ])("replaces %s", (raw) => expect(s(`Met ${raw} today.`)).toBe(`Met ${jose.first}${raw.includes("&nbsp;") ? "&nbsp;" : " "}${jose.last} today.`));
  it("replaces an encoded name in an attribute and keeps an encoded possessive", () => {
    expect(s('<img alt="Jos&eacute; N&uacute;&ntilde;ez">')).toBe(`<img alt="${jose.first} ${jose.last}">`);
    expect(s("Jos&eacute; N&uacute;&ntilde;ez&rsquo;s plan")).toBe(`${jose.first} ${jose.last}&rsquo;s plan`);
    expect(s("JOS&Eacute; N&Uacute;&Ntilde;EZ")).toBe(`${jose.first.toUpperCase()} ${jose.last.toUpperCase()}`);
  });
});

describe("names with offices, initials and quotes", () => {
  const corin = fakeOf("dbo.Ministry:M1");
  const bexley = fakeOf("calendar.GovernmentRepresentative:2");
  const perrin = fakeOf("media.Contact:10");
  const brennick = fakeOf("media.Contact:11");
  const fenna = fakeOf("calendar.SystemUser:3");
  it("finds a person whose listed name carries an office", () => {
    expect(s("Minister Corin Vale said")).toBe(`Minister ${corin.first} ${corin.last} said`);
    expect(s("Premier Bexley Strand spoke")).toBe(`Premier ${bexley.first} ${bexley.last} spoke`);
  });
  it("skips one middle initial", () => {
    expect(s("Quill A. Ashbury spoke")).toBe(`${quill.first} ${quill.last} spoke`);
    expect(s("Quill A Ashbury spoke")).toBe(`${quill.first} ${quill.last} spoke`);
    expect(s("Quill A. B. Ashbury")).toBe("Quill A. B. Ashbury");
  });
  it("matches a person known only by an initial and keeps it an initial", () => {
    expect(s("T. Brennick spoke")).toBe(`${brennick.first[0]}. ${brennick.last} spoke`);
    expect(s("Brennick, T.")).toBe(`${brennick.last}, ${brennick.first[0]}.`);
  });
  it("handles a plural possessive and quotes", () => {
    expect(s("Perrin Halloways' plan")).toBe(`${perrin.first} ${perrin.last}' plan`);
    expect(s("'Quill Ashbury'")).toBe(`'${quill.first} ${quill.last}'`);
    expect(s("‘Quill Ashbury’")).toBe(`‘${quill.first} ${quill.last}’`);
  });
  it("leaves no double space where a middle name is dropped", () => {
    expect(s("Fenna Rook Lindqvist spoke")).toBe(`${fenna.first} ${fenna.last} spoke`);
    expect(s("Lindqvist, Fenna Rook spoke")).toBe(`${fenna.last}, ${fenna.first} spoke`);
  });
  it("accepts a space before the surname-first comma", () => expect(s("Ashbury , Quill said")).toBe(`${quill.last} , ${quill.first} said`));
});

describe("emails", () => {
  it("maps a known person's email to their fictional one", () => expect(s("Write quill.ashbury@gov.example.")).toBe(`Write ${quill.email}.`));
  it("maps an unknown email to a numbered example.test address", () => expect(s("press@news.example")).toMatch(/^person\d+@example\.test$/));
  it("leaves example.test alone", () => expect(s("editor@example.test")).toBe("editor@example.test"));
});

describe("phones", () => {
  it.each(["604-555-0142", "(604) 555-0142", "604.555.0142", "+1 604 555 0142", "1-800-555-0142", "604-555-0142 ext. 123", "604-555-0142 x123", "604 555 0142"])("replaces %s", (p) => {
    const out = s(`Call ${p} now`);
    expect(out).toMatch(/^Call 250-555-01\d\d now$/);
  });
  it("replaces a seven-digit local number", () => expect(s("Call 555.0142 now")).toMatch(/^Call 555-01\d\d now$/));
  it("replaces a seven-digit local number at the end of a sentence", () => {
    expect(s("Call 604-555-0142 or 555-0142.")).toMatch(/^Call 250-555-01\d\d or 555-01\d\d\.$/);
    expect(s("Call 555.0142.")).toMatch(/^Call 555-01\d\d\.$/);
    expect(s("Version 555.0142.7")).toBe("Version 555.0142.7");
  });
  it("replaces a number written with en dashes", () => expect(s("Call 604–555–0142 now")).toMatch(/^Call 250-555-01\d\d now$/));
  it.each(["2025-2026", "2026HLTH0001-000001", "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "$1,250,000", "10:30 a.m.", "NEWS-12345", "2026-10-22"])("leaves %s alone", (t) => expect(s(t)).toBe(t));
});

describe("re-running", () => {
  const sample = "Quill Ashbury (604) 555-0142, quill.ashbury@gov.example; Ashbury, Quill's note to press@news.example and Hon. Dorian Feld at 555.0142.";
  it("is idempotent", () => {
    const once = s(sample);
    expect(s(once)).toBe(once);
    expect(scrubText(once, ctx).counts).toEqual({ names: 0, emails: 0, phones: 0 });
  });
  it("gives the same output from an index built from the rows in another order", () => {
    const reordered = buildPeopleIndex([
      { source: "media.Contact", id: "12", names: ["J.R. Pellow"], email: null, phones: [] },
      { source: "calendar.SystemUser", id: "3", names: ["Fenna Rook Lindqvist"], email: null, phones: [], alwaysPerson: true },
      { source: "media.Contact", id: "11", names: ["T. Brennick"], email: null, phones: [] },
      { source: "media.Contact", id: "10", names: ["Perrin Halloways"], email: null, phones: [] },
      { source: "calendar.GovernmentRepresentative", id: "2", names: ["Premier Bexley Strand (Acting)"], email: null, phones: [] },
      { source: "dbo.Ministry", id: "M1", names: ["Hon. Corin Vale, Minister of Health"], email: null, phones: [] },
      { source: "calendar.SystemUser", id: "2", names: ["Marisol Tennant-Vey"], email: null, phones: [], alwaysPerson: true },
      { source: "media.Contact", id: "9", names: ["José Ñúñez"], email: null, phones: [] },
      { source: "calendar.GovernmentRepresentative", id: "1", names: ["Hon. Dorian Feld"], email: null, phones: [] },
      { source: "calendar.SystemUser", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: ["(604) 555-0142"], alwaysPerson: true },
    ], KEY);
    expect(scrubText(sample, { index: reordered, key: KEY }).text).toBe(s(sample));
  });
});

describe("findLeaks", () => {
  it("finds every kind before scrubbing and nothing after", () => {
    const raw = "Quill Ashbury, quill.ashbury@gov.example, 604-555-0142";
    expect(new Set(findLeaks(raw, index))).toEqual(new Set(["name", "name-plain", "email", "phone"]));
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
  it("finds names by the plain route too", () => {
    expect(plainNameHits("met Quill Ashbury and Ashbury, Quill", index)).toBe(2);
    expect(plainNameHits("met Quill<br/>Ashbury", index)).toBe(1);
    expect(plainNameHits("(Quill Ashbury), then Quill Ashbury's.", index)).toBe(2);
  });

  it.each([
    '<img src="a.png" alt="Quill Ashbury">',
    "<a title='Ashbury, Quill'>x</a>",
    "Jos&eacute; &Ntilde;&uacute;&ntilde;ez",
    "Jos&#233; &#xD1;&#250;&#xF1;ez",
    '<img alt="Jos&eacute; N&uacute;&ntilde;ez">',
    "Minister Corin Vale said",
    "Premier Bexley Strand spoke",
    "Quill A. Ashbury spoke",
    "Quill A Ashbury spoke",
    "T. Brennick spoke",
    "Brennick, T.",
    "Perrin Halloways' plan",
    "'Quill Ashbury'",
    "Fenna Rook Lindqvist spoke",
    "Ashbury , Quill said",
    "Quill Ashbury&#8217;s team",
    `<img data-src="${"z".repeat(250)}" alt="Quill Ashbury">`,
    "J.R. Pellow said",
  ])("finds %j by both routes before scrubbing and nothing after", (raw) => {
    const before = findLeaks(raw, index);
    expect(before).toContain("name");
    expect(before).toContain("name-plain");
    const after = s(raw);
    expect(findLeaks(after, index)).toEqual([]);
    expect(after).not.toMatch(real);
  });

  it.each(["Call 555.0142.", "Call 604–555–0142 now"])("finds the phone in %j", (raw) => {
    expect(findLeaks(raw, index)).toContain("phone");
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
});
