import { describe, expect, it } from "vitest";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";
import { findLeaks, plainNameHits, scrubText } from "../../scripts/lib/scrub/text";

const KEY = "d".repeat(64);
const index = buildPeopleIndex([
  { source: "calendar.SystemUser", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: ["(604) 555-0142"], alwaysPerson: true },
  { source: "calendar.GovernmentRepresentative", id: "1", names: ["Hon. Dorian Feld"], email: null, phones: [] },
  { source: "media.Contact", id: "9", names: ["José Ñúñez"], email: null, phones: [] },
  { source: "calendar.SystemUser", id: "2", names: ["Marisol Tennant-Vey"], email: null, phones: [], alwaysPerson: true },
], KEY);
const ctx = { index, key: KEY };
const quill = index.bySource.get("calendar.SystemUser:1")!.fake;
const s = (t: string) => scrubText(t, ctx).text;

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
  it.each(["2025-2026", "2026HLTH0001-000001", "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "$1,250,000", "10:30 a.m.", "NEWS-12345", "2026-10-22"])("leaves %s alone", (t) => expect(s(t)).toBe(t));
});

describe("re-running", () => {
  const sample = "Quill Ashbury (604) 555-0142, quill.ashbury@gov.example; Ashbury, Quill's note to press@news.example and Hon. Dorian Feld at 555.0142.";
  it("is idempotent", () => {
    const once = s(sample);
    expect(s(once)).toBe(once);
    expect(scrubText(once, ctx).counts).toEqual({ names: 0, emails: 0, phones: 0 });
  });
  it("is deterministic", () => expect(s(sample)).toBe(s(sample)));
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
});
