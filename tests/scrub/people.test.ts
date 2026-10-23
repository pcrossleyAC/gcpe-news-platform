import { describe, expect, it } from "vitest";
import { buildPeopleIndex, mappingCsv, nameVariants, normEmail, parseName, type PersonSource } from "../../scripts/lib/scrub/people";

const KEY = "c".repeat(64);
const src = (source: string, id: string, names: (string | null)[], email: string | null = null, extra: Partial<PersonSource> = {}): PersonSource => ({ source, id, names, email, phones: [], ...extra });

describe("parseName", () => {
  it.each([
    ["Quill Ashbury", { given: ["quill"], surname: ["ashbury"] }],
    ["Ashbury, Quill", { given: ["quill"], surname: ["ashbury"] }],
    ["Hon. Dorian Feld", { given: ["dorian"], surname: ["feld"] }],
    ["José Ñúñez", { given: ["jose"], surname: ["nunez"] }],
    ["Marisol Tennant-Vey", { given: ["marisol"], surname: ["tennant-vey"] }],
    ["Quill Q. Ashbury", { given: ["quill"], surname: ["ashbury"] }],
  ])("parses %s", (raw, expected) => expect(parseName(raw)).toEqual(expected));

  it.each(["Premier", "Deputy Minister", "Admin", "", null, "Room 250", "a@b.example", "One Two Three Four Five"])("rejects %j", (raw) => expect(parseName(raw)).toBeNull());

  it.each([
    "Premier Quill Ashbury", "Minister Quill Ashbury", "Hon. Minister Quill Ashbury", "Parliamentary Secretary Quill Ashbury", "MLA Quill Ashbury",
    "The Honourable Quill Ashbury", "Assistant Deputy Minister Quill Ashbury", "Minister of Health Quill Ashbury", "Minister of State for Trade Quill Ashbury",
    "Quill Ashbury, MLA", "Quill Ashbury (Acting)", "Hon. Quill Ashbury, Minister of Health", "Quill Ashbury, Jr.", "Quill Ashbury MLA",
    "Ashbury, Quill (Acting)", "Ashbury, Hon. Quill", "Quill A. Ashbury", "Quill A Ashbury", "Minister of Health (Quill Ashbury)",
  ])("finds the name inside %j", (raw) => expect(parseName(raw)).toEqual({ given: ["quill"], surname: ["ashbury"] }));

  it("keeps a lone initial as the given name and reads a surname particle before the comma", () => {
    expect(parseName("Q. Ashbury")).toEqual({ given: ["q"], surname: ["ashbury"] });
    expect(parseName("Van Dyk, Quill")).toEqual({ given: ["quill"], surname: ["van", "dyk"] });
  });

  it.each([
    "Executive Assistant to the Minister", "Special Advisor to the Premier", "Deputy Minister to the Premier", "Secretary to Cabinet",
    "Minister of Tourism, Arts, Culture and Sport", "Minister of Lakes, Trails and Parks", "Chief Information Officer",
    "Government Chief Information Officer", "Health Minister", "Board Chair", "Grand Chief", "Lieutenant Governor", "Provincial Health Officer",
  ])("gives the office %j no variants", (raw) => expect(nameVariants(raw)).toEqual([]));

  it.each([
    ["Grand Chief Ira Yellowhorse", "ira", "yellowhorse"], ["Regional Chief Ira Yellowhorse", "ira", "yellowhorse"], ["Elder Ira Yellowhorse", "ira", "yellowhorse"],
    ["Board Chair Ira Yellowhorse", "ira", "yellowhorse"], ["Lieutenant Governor Ira Yellowhorse", "ira", "yellowhorse"], ["Health Minister Ira Yellowhorse", "ira", "yellowhorse"],
    ["Provincial Health Officer Dr. Nell Ambrose", "nell", "ambrose"], ["Quill Elder", "quill", "elder"], ["Quill Mayor", "quill", "mayor"],
  ])("finds the name inside the office %j", (raw, given, surname) => expect(parseName(raw)).toEqual({ given: [given], surname: [surname] }));

  it("reads a non-breaking hyphen or en dash in a surname as a hyphen", () => {
    expect(parseName("Ira Yellow\u2011Horse")).toEqual({ given: ["ira"], surname: ["yellow-horse"] });
    expect(parseName("Ira Yellow\u2013Horse")).toEqual({ given: ["ira"], surname: ["yellow-horse"] });
  });

  it("indexes the last given word with the surname behind an unknown office, unless another person owns that form", () => {
    expect(nameVariants("Grand Poobah Quill Ashbury").map((v) => v.key)).toContain("quill ashbury");
    const both = buildPeopleIndex([src("media.Contact", "1", ["Quill Bryn Ashbury"]), src("media.Contact", "2", ["Bryn Ashbury"])], KEY);
    expect(both.byVariant.get("bryn ashbury")?.person.sources).toEqual(["media.Contact:2"]);
  });

  it.each(["Minister of Health", "Deputy Minister of Health Services", "Minister of Health and Addictions", "Director, Communications", "Premier (Acting)", "Quill A.", "Executive Director, Media Relations"])("rejects the office %j", (raw) => expect(parseName(raw)).toBeNull());

  it.each([
    ["Kevin To", ["kevin"], ["to"]], ["Mai On", ["mai"], ["on"]], ["Ivo And", ["ivo"], ["and"]],
  ])("reads a link word as the surname of a two-word name %j", (raw, given, surname) => expect(parseName(raw)).toEqual({ given, surname }));
  it.each(["Quill Ashbury To", "Assistant to", "Minister of", "Chief of Staff to"])("still rejects a link word that ties an office %j", (raw) => expect(parseName(raw)).toBeNull());

  it.each([
    ["Ashbury, Quill Bryn", ["quill", "bryn"]], ["Ashbury, Quill B Bryn", ["quill", "bryn"]], ["Ashbury, Quill FOR:EX", ["quill", "for", "ex"]],
    ["Ashbury, Quill B FOR:EX", ["quill", "for", "ex"]], ["Ashbury, Quill ON:IN", ["quill", "on", "in"]],
  ])("reads %j as Last, First Middle", (raw, given) => {
    expect(parseName(raw)).toEqual({ given, surname: ["ashbury"] });
    expect(nameVariants(raw).map((v) => v.key)).toEqual(expect.arrayContaining(["quill ashbury", "ashbury , quill"]));
  });
  it("reads a name pushed past four words by a directory tag without the tag", () => {
    expect(parseName("Ashbury, Quill Bryn GCPE:EX")).toEqual({ given: ["quill", "bryn"], surname: ["ashbury"] });
    expect(parseName("Ashbury, Quill Bryn FOR:EX")).toEqual({ given: ["quill", "bryn"], surname: ["ashbury"] });
    expect(parseName("One Two Three Four Five")).toBeNull();
  });
  it("makes no fallback from a directory tag", () => {
    expect(nameVariants("Ashbury, Quill FOR:EX").map((v) => v.key)).not.toContain("ex ashbury");
    expect(nameVariants("Ashbury, Quill Bryn").map((v) => v.key)).toContain("bryn ashbury");
  });

  it.each([["Elder, Quill", "elder"], ["Mayor, Quill", "mayor"], ["Grand, Quill", "grand"]])("reads the one-word office head of %j as a surname", (raw, surname) => {
    expect(parseName(raw)).toEqual({ given: ["quill"], surname: [surname] });
  });
  it.each(["Premier, Quill", "Chief, Quill", "Minister, Quill", "Director, Quill"])("still rejects the office head %j", (raw) => expect(parseName(raw)).toBeNull());

  it("reads two people sharing a surname from the first and the fallback", () => {
    expect(parseName("Quill and Bryn Ashbury")).toEqual({ given: ["quill", "and", "bryn"], surname: ["ashbury"] });
    expect(nameVariants("Quill and Bryn Ashbury").map((v) => v.key)).toEqual(expect.arrayContaining(["quill ashbury", "bryn ashbury"]));
    expect(parseName("And Quill Ashbury")).toBeNull();
  });

  it.each([["Quill TBD", "tbd"], ["Quill Unknown", "unknown"], ["Quill Videographer", "videographer"], ["Quill Staff", "staff"]])(
    "keeps a given name with a stand-in surname %j", (raw, surname) => expect(parseName(raw)).toEqual({ given: ["quill"], surname: [surname] }),
  );
  it.each(["Media Relations", "Communications Team", "GCPE Office"])("still rejects the role %j", (raw) => expect(parseName(raw)).toBeNull());

  it.each(["Digital Strategist", "Senior Policy Analyst", "Content Lead", "News Editor", "Photo Gallery", "Outreach Specialist", "Events Coordinator", "Project Manager"])(
    "rejects the job title %j", (raw) => expect(parseName(raw)).toBeNull(),
  );
});

describe("nameVariants", () => {
  it("covers the full, first-last and surname-first forms", () => {
    expect(nameVariants("Quill Bryn Ashbury").map((v) => v.key).sort()).toEqual(["ashbury , quill", "ashbury , quill bryn", "bryn ashbury", "quill ashbury", "quill bryn ashbury"].sort());
    expect(nameVariants("Quill Bryn Ashbury").find((v) => v.key === "bryn ashbury")?.fallback).toBe(true);
    expect(nameVariants("Quill Ashbury").find((v) => v.key === "ashbury , quill")?.surnameFirst).toBe(true);
  });
  it.each([["Quill de la Cruz", "la cruz"], ["Quill van Dyk", "van dyk"], ["Quill Bryn de Souza", "de souza"], ["Quill del Rio", "del rio"], ["Quill Los Santos", "los santos"]])(
    "makes no fallback starting with a surname particle in %j", (raw, form) => {
      expect(nameVariants(raw).filter((v) => v.fallback).map((v) => v.key)).not.toContain(form);
      expect(nameVariants(raw).length).toBeGreaterThan(0);
    },
  );
});

describe("normEmail", () => {
  it("lowercases valid addresses and drops invalid ones", () => {
    expect(normEmail(" Quill.Ashbury@Gov.Example ")).toBe("quill.ashbury@gov.example");
    expect(normEmail("quill at gov")).toBeNull();
    expect(normEmail(null)).toBeNull();
  });
});

describe("buildPeopleIndex", () => {
  const sources: PersonSource[] = [
    src("calendar.SystemUser", "1", ["Quill Ashbury", "Ashbury, Quill"], "quill.ashbury@gov.example", { alwaysPerson: true, phones: ["(604) 555-0142"] }),
    src("dbo.User", "U1", ["Quill Ashbury"], "Quill.Ashbury@gov.example", { alwaysPerson: true }),
    src("calendar.CommunicationContact", "7", ["Q. Ashbury"], null, { linkId: "1", linkSource: "calendar.SystemUser" }),
    src("calendar.GovernmentRepresentative", "1", ["Hon. Dorian Feld"]),
    src("dbo.Ministry", "M1", ["Dorian Feld"], "dorian.feld@gov.example"),
    src("calendar.GovernmentRepresentative", "2", ["Premier"]),
    src("calendar.SystemUser", "3", ["Admin"], null, { alwaysPerson: true }),
  ];
  const index = buildPeopleIndex(sources, KEY, new Set(["editor@example.test"]));
  const of = (k: string) => index.bySource.get(k);

  it("joins rows sharing an email, whatever the case", () => {
    expect(of("calendar.SystemUser:1")).toBe(of("dbo.User:U1"));
  });

  it("joins a comm contact to the user it names", () => {
    expect(of("calendar.CommunicationContact:7")).toBe(of("calendar.SystemUser:1"));
  });

  it("joins a name-only row to the person with that name", () => {
    expect(of("calendar.GovernmentRepresentative:1")).toBe(of("dbo.Ministry:M1"));
  });

  it("leaves a role name out but still gives every user row an identity", () => {
    expect(of("calendar.GovernmentRepresentative:2")).toBeUndefined();
    expect(of("calendar.SystemUser:3")?.fake.full).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("indexes variants, emails and the tokens a match can start with", () => {
    expect(index.byVariant.get("quill ashbury")?.person).toBe(of("calendar.SystemUser:1"));
    expect(index.byVariant.get("ashbury , quill")?.surnameFirst).toBe(true);
    expect(index.byEmail.get("quill.ashbury@gov.example")).toBe(of("calendar.SystemUser:1"));
    expect(index.firstTokens.has("quill") && index.firstTokens.has("ashbury")).toBe(true);
    expect(index.maxWords).toBeGreaterThanOrEqual(2);
  });

  it("joins a row whose name carries an office to the person without it", () => {
    const withTitles = buildPeopleIndex([
      src("dbo.Ministry", "M2", ["Hon. Corin Vale, Minister of Health"]),
      src("calendar.GovernmentRepresentative", "5", ["Premier Corin Vale (Acting)"]),
      src("calendar.SystemUser", "9", ["Corin Vale"], "corin.vale@gov.example", { alwaysPerson: true }),
    ], KEY);
    expect(withTitles.persons).toHaveLength(1);
    expect(withTitles.byVariant.get("corin vale")?.person.sources).toHaveLength(3);
  });

  it("is deterministic for the same rows in any order", () => {
    const again = buildPeopleIndex([...sources].reverse(), KEY, new Set(["editor@example.test"]));
    expect(again.bySource.get("calendar.SystemUser:1")?.fake).toEqual(of("calendar.SystemUser:1")?.fake);
  });

  it("never gives a fake name equal to a real one", () => {
    const real = new Set(index.persons.flatMap((p) => p.names.flatMap((n) => nameVariants(n).map((v) => v.key))));
    for (const p of index.persons) expect(real.has(p.fake.full.toLowerCase())).toBe(false);
  });

  it("writes a mapping with one row per person", () => {
    const csv = mappingCsv(index).trim().split("\n");
    expect(csv[0]).toBe("person_key,real_names,real_emails,fake_name,fake_email,fake_phone");
    expect(csv).toHaveLength(index.persons.length + 1);
  });
});
