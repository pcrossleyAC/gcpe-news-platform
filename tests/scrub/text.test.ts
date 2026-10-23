import { describe, expect, it } from "vitest";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";
import { buildLiteralNeedles, literalHits } from "../../scripts/lib/scrub/mssql-text";
import { findLeaks, plainContactHits, plainNameHits, scrubText } from "../../scripts/lib/scrub/text";

const KEY = "d".repeat(64);
/** Office-only rows that must not become persons, and people behind offices or with dashed surnames. */
const more = [
  { source: "calendar.GovernmentRepresentative", id: "10", names: ["Executive Assistant to the Minister"], email: null, phones: [] },
  { source: "calendar.GovernmentRepresentative", id: "11", names: ["Secretary to Cabinet"], email: null, phones: [] },
  { source: "dbo.Ministry", id: "M9", names: ["Minister of Tourism, Arts, Culture and Sport"], email: null, phones: [] },
  { source: "calendar.GovernmentRepresentative", id: "12", names: ["Chief Information Officer"], email: null, phones: [] },
  { source: "calendar.GovernmentRepresentative", id: "13", names: ["Grand Chief Ira Yellowhorse"], email: null, phones: [] },
  { source: "calendar.GovernmentRepresentative", id: "14", names: ["Provincial Health Officer Dr. Nell Ambrose"], email: null, phones: [] },
  { source: "media.Contact", id: "13", names: ["Odette Marrow-Lisle"], email: null, phones: [] },
];
const index = buildPeopleIndex([
  ...more,
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
const real = /\b(?:Quill|Ashbury|Dorian|Feld|Marisol|Tennant|Corin|Vale|Bexley|Strand|Perrin|Halloways|Brennick|Fenna|Rook|Lindqvist|Pellow|Yellowhorse|Ambrose|Marrow|Lisle)\b|Jos(?:e|é|&eacute;|&#233;)|N(?:u|ú|&uacute;)(?:n|ñ|&ntilde;)ez/i;

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
  it("ignores accents", () => expect(s("with Jose Nunez")).not.toMatch(/jose|nunez/i));
  it.each(["with jose nunez", "met quill ashbury today", "quill ashbury-led", "Quill ashbury said"])(
    "leaves the lower-case or mixed %j to the literal route", (raw) => {
      expect(s(raw)).toBe(raw);
      expect(findLeaks(raw, index)).toEqual([]);
      expect(literalHits(raw, buildLiteralNeedles(index)).map((h) => h.kind)).toContain("literal-name");
    },
  );
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

describe("offices and dashed surnames", () => {
  it.each([
    "The report goes to the Minister today.", "Send it to Cabinet first.", "Ask the Chief Information Officer.", "The Government Chief Information Officer spoke.",
    "Minister of Tourism, Arts, Culture and Sport", "Tourism, arts and culture grew.", "An assistant to the Premier called.",
  ])("leaves %j unchanged", (t) => {
    expect(s(t)).toBe(t);
    expect(findLeaks(t, index)).toEqual([]);
  });
  it("finds people behind offices the old role list didn't know", () => {
    const ira = fakeOf("calendar.GovernmentRepresentative:13");
    const nell = fakeOf("calendar.GovernmentRepresentative:14");
    expect(s("Grand Chief Ira Yellowhorse spoke")).toBe(`Grand Chief ${ira.first} ${ira.last} spoke`);
    expect(s("Provincial Health Officer Dr. Nell Ambrose")).toBe(`Provincial Health Officer Dr. ${nell.first} ${nell.last}`);
  });
  it("reads a non-breaking hyphen or en dash in a surname as a hyphen", () => {
    const odette = fakeOf("media.Contact:13");
    for (const dash of ["-", "\u2011", "&#8209;", "\u2013", "&ndash;", "&#8211;"]) expect(s(`Odette Marrow${dash}Lisle said`)).toBe(`${odette.first} ${odette.last} said`);
  });
  it("finds a name before a hyphenated suffix", () => {
    expect(s("a Quill Ashbury-led review")).toBe(`a ${quill.first} ${quill.last}-led review`);
    expect(s("the Quill Ashbury\u2013era rules")).toBe(`the ${quill.first} ${quill.last}\u2013era rules`);
    expect(s("Marisol Tennant-Smith")).toBe("Marisol Tennant-Smith");
  });
});

describe("names joined by a dash, link-word surnames and office-word heads", () => {
  const ix = buildPeopleIndex([
    { source: "media.Contact", id: "1", names: ["Quill Ashbury"], email: null, phones: [] },
    { source: "media.Contact", id: "2", names: ["Thea Marchbank"], email: null, phones: [] },
    { source: "media.Contact", id: "3", names: ["Wendell Okafor-Brice"], email: null, phones: [] },
    { source: "media.Contact", id: "4", names: ["Kevin To"], email: null, phones: [] },
    { source: "media.Contact", id: "5", names: ["Marisol Short"], email: null, phones: [] },
    { source: "calendar.SystemUser", id: "6", names: ["Elder, Odile"], email: null, phones: [] },
    { source: "calendar.SystemUser", id: "7", names: ["Pellam, Isak FOR:EX"], email: null, phones: [] },
    { source: "calendar.SystemUser", id: "8", names: ["Marrowby, Juno Tamsin GCPE:EX"], email: null, phones: [] },
  ], KEY);
  const f = (id: string) => ix.persons.find((p) => p.sources.some((x) => x.endsWith(`:${id}`)))!.fake;
  const sx = (t: string) => scrubText(t, { index: ix, key: KEY }).text;
  const [qa, tm, wo, kt, ms, oe, ip, jm] = ["1", "2", "3", "4", "5", "6", "7", "8"].map(f);
  const realX = /Quill|Ashbury|Thea|Marchbank|Wendell|Okafor|Brice|Kevin|Odile|Isak|Pellam|Juno|Tamsin|Marrowby/;

  it.each([
    ["the Quill Ashbury\u2013Thea Marchbank meeting", () => `the ${qa!.first} ${qa!.last}\u2013${tm!.first} ${tm!.last} meeting`],
    ["the Quill Ashbury&ndash;Thea Marchbank meeting", () => `the ${qa!.first} ${qa!.last}&ndash;${tm!.first} ${tm!.last} meeting`],
    ["Victoria\u2013Thea Marchbank", () => `Victoria\u2013${tm!.first} ${tm!.last}`],
    ["Wendell Okafor-Brice\u2013Thea Marchbank", () => `${wo!.first} ${wo!.last}\u2013${tm!.first} ${tm!.last}`],
    ["Wendell Okafor-Brice\u2011Thea Marchbank", () => `${wo!.first} ${wo!.last}\u2011${tm!.first} ${tm!.last}`],
    ["Thea Marchbank-Quill Ashbury", () => `${tm!.first} ${tm!.last}-${qa!.first} ${qa!.last}`],
  ])("replaces both names in %j and both routes see them", (raw, want) => {
    const names = (raw.match(/Thea|Quill|Wendell/g) ?? []).length;
    expect(sx(raw)).toBe(want());
    expect(findLeaks(raw, ix).filter((k) => k === "name")).toHaveLength(names);
    expect(plainNameHits(raw, ix)).toBe(names);
    expect(findLeaks(sx(raw), ix)).toEqual([]);
    expect(sx(raw)).not.toMatch(realX);
  });

  it("leaves a hyphenated word alone when its case doesn't match the given name", () => {
    expect(sx("a Marisol short-term plan")).toBe("a Marisol short-term plan");
    expect(findLeaks("a Marisol short-term plan", ix)).toEqual([]);
    expect(sx("a Marisol Short-led plan")).toBe(`a ${ms!.first} ${ms!.last}-led plan`);
  });

  it("replaces a link-word surname only when it is cased like a name", () => {
    expect(sx("Kevin To said")).toBe(`${kt!.first} ${kt!.last} said`);
    expect(sx("To, Kevin said")).toBe(`${kt!.last}, ${kt!.first} said`);
    expect(sx("We asked Kevin to attend.")).toBe("We asked Kevin to attend.");
    expect(findLeaks("We asked Kevin to attend.", ix)).toEqual([]);
    expect(findLeaks("Kevin To said", ix)).toEqual(["name", "name-plain"]);
  });

  it("finds people listed as Elder, Given and as Last, First Middle with a directory tag", () => {
    expect(sx("Odile Elder spoke")).toBe(`${oe!.first} ${oe!.last} spoke`);
    expect(sx("Elder, Odile spoke")).toBe(`${oe!.last}, ${oe!.first} spoke`);
    expect(sx("Isak Pellam spoke")).toBe(`${ip!.first} ${ip!.last} spoke`);
    expect(sx("an ex Pellam rule")).toBe("an ex Pellam rule");
    expect(sx("Juno Marrowby and Juno Tamsin Marrowby")).toBe(`${jm!.first} ${jm!.last} and ${jm!.first} ${jm!.last}`);
    for (const t of ["Isak Pellam spoke", "Juno Tamsin Marrowby spoke"]) {
      expect(findLeaks(t, ix)).toEqual(["name", "name-plain"]);
      expect(findLeaks(sx(t), ix)).toEqual([]);
    }
  });
});

describe("ordinary words that look like listed names", () => {
  const rows = ["Leader, Official Opposition", "Speaker, Legislative Assembly", "Mayor, Nelson", "General, Canadian Forces", "News Staff",
    "Support Staff", "Arts and Culture", "Parks and Recreation", "Mark Short", "Quill Ashbury"];
  const ix = buildPeopleIndex(rows.map((n, i) => ({ source: "media.Contact", id: String(i), names: [n], email: null, phones: [] })), KEY);
  const sx = (t: string) => scrubText(t, { index: ix, key: KEY }).text;
  const mark = ix.persons.find((p) => p.names.includes("Mark Short"))!.fake;

  it.each([
    "The Opposition Leader said", "The Official Opposition Leader said", "Leader, Official Opposition", "the Legislative Assembly Speaker",
    "Speaker, Legislative Assembly", "Nelson Mayor", "Mayor, Nelson", "Canadian Forces General", "General, Canadian Forces",
    "news staff", "support staff", "News Staff", "Support Staff", "arts and culture", "Arts and Culture", "ARTS AND CULTURE", "parks and recreation",
    "Parks and Recreation", "to mark short-term gains", "Government to Mark Short-Term Milestones", "MARK SHORT-TERM GAINS",
    "GOVERNMENT TO MARK SHORT", "asked mark short to wait",
  ])("leaves %j unchanged", (raw) => {
    expect(sx(raw)).toBe(raw);
    expect(findLeaks(raw, ix)).toEqual([]);
  });

  it("still replaces the person written like a name", () => {
    expect(sx("Mark Short said")).toBe(`${mark.first} ${mark.last} said`);
    expect(sx("MARK SHORT said")).toBe(`${mark.first.toUpperCase()} ${mark.last.toUpperCase()} said`);
    expect(sx("a Mark Short-led plan")).toBe(`a ${mark.first} ${mark.last}-led plan`);
  });

  it.each([800, 5000])("finishes a %i-piece dash-joined word in under a second", (pieces) => {
    const word = Array.from({ length: pieces }, (_, i) => (i % 2 ? "Ashbury" : "Quill")).join("-");
    const t0 = performance.now();
    scrubText(`a ${word} b`, { index: ix, key: KEY });
    findLeaks(`a ${word} b`, ix);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
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

describe("emails and phones written with entities", () => {
  it.each([
    "604&nbsp;555&nbsp;0142", "(604)&nbsp;555-0142", "+1&nbsp;604&nbsp;555&nbsp;0142", "604&#160;555-0142", "604&#xA0;555&#xa0;0142",
    "604\u00a0555\u00a00142", "604&thinsp;555&thinsp;0142", "604&ndash;555&ndash;0142", "604&#8211;555&#8211;0142",
    "604&#8209;555&#8209;0142", "604-555-0142&nbsp;ext.&nbsp;12",
  ])("replaces %s and both routes report it first", (p) => {
    const raw = `Call ${p} now`;
    expect(s(raw)).toMatch(/^Call 250-555-01\d\d now$/);
    expect(findLeaks(raw, index)).toContain("phone");
    expect(plainContactHits(raw).phones).toBe(1);
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
  it.each([
    ["quill.ashbury&#64;gov.example", quill.email],
    ["quill.ashbury&commat;gov.example", quill.email],
    ["quill.ashbury&#x40;gov.example", quill.email],
  ])("replaces %s and both routes report it first", (e, fake) => {
    const raw = `Write <a href="mailto:${e}">${e}</a>.`;
    expect(s(raw)).toBe(`Write <a href="mailto:${fake}">${fake}</a>.`);
    expect(findLeaks(raw, index).filter((k) => k === "email")).toHaveLength(2);
    expect(plainContactHits(raw).emails).toBe(2);
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
  it("maps an unknown encoded email to a numbered example.test address", () => expect(s("press&#64;news.example")).toMatch(/^person\d+@example\.test$/));
  it.each([
    "October 22&nbsp;2026", "2026&nbsp;22", "1&nbsp;000 people", "1&nbsp;000&nbsp;000 dollars", "250&nbsp;000 people", "ISBN 978-0-306-40615-7",
    "ISBN&nbsp;978&nbsp;0&nbsp;306&nbsp;40615&nbsp;7", "0-306-40615-2", "978&ndash;1&ndash;55501&ndash;142&ndash;6", "pages 100&ndash;1000", "2025&ndash;2026",
  ])("leaves %s alone", (t) => {
    expect(s(t)).toBe(t);
    expect(findLeaks(t, index)).toEqual([]);
    expect(plainContactHits(t)).toEqual({ emails: 0, phones: 0 });
  });
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
      ...[...more].reverse(),
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
    "Grand Chief Ira Yellowhorse spoke",
    "Provincial Health Officer Dr. Nell Ambrose",
    "Odette Marrow\u2011Lisle said",
    "Odette Marrow&ndash;Lisle said",
    "a Quill Ashbury-led review",
  ])("finds %j by both routes before scrubbing and nothing after", (raw) => {
    const before = findLeaks(raw, index);
    expect(before).toContain("name");
    expect(before).toContain("name-plain");
    const after = s(raw);
    expect(findLeaks(after, index)).toEqual([]);
    expect(after).not.toMatch(real);
  });

  it.each(["2024 \u2013 2025 \u2013 2026", "pages 100 \u2013 200", "1 \u2013 800 \u2013 22", "scores 604 \u2013 55 \u2013 0142", "604 \u2013 5550 \u2013 142"])("leaves the dashed non-phone %j alone", (raw) => {
    expect(s(raw)).toBe(raw);
    expect(findLeaks(raw, index)).toEqual([]);
  });

  it.each(["Call 555.0142.", "Call 604–555–0142 now", "Call 604 \u2013 555 \u2013 0142 now", "Call 604 - 555 - 0142 now"])("finds the phone in %j", (raw) => {
    expect(findLeaks(raw, index)).toContain("phone");
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
});
