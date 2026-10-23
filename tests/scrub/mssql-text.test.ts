import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScope, emptyTables } from "../../scripts/lib/scrub/mssql";
import { buildLiteralNeedles, gateMssql, literalHits, readPeopleSources, scrubAllText, writeStructuredPeople } from "../../scripts/lib/scrub/mssql-text";
import { buildPeopleIndex, parseName, type PeopleIndex } from "../../scripts/lib/scrub/people";
import { createFixture, FIXTURE_KEY, mssqlTestConfig, REF_UTC, REF_WALL, SKIP_MESSAGE } from "./mssql-fixture";

/** A name the parser can't read (six words), so only the literal route knows it. */
const UNPARSED = "Ximena de la Paz Okonkwo Ruiz";
/** A minister listed by honorific and surname only: unparseable, indexed through the email. */
const MINISTER = "Hon. Okonkwo-Bell";

describe("the literal route", () => {
  const index = buildPeopleIndex([
    { source: "calendar.SystemUser", id: "1", names: ["Quill Ashbury", "Ashbury, Quill"], email: "quill.ashbury@gov.example", phones: ["(604) 555-0142", "250.555.0161"], alwaysPerson: true },
    { source: "calendar.SystemUser", id: "2", names: [UNPARSED], email: null, phones: [], alwaysPerson: true },
    { source: "calendar.SystemUser", id: "3", names: ["Admin"], email: null, phones: ["555-0177"], alwaysPerson: true },
    { source: "dbo.Ministry", id: "M2", names: [MINISTER], email: "okonkwo-bell@gov.example", phones: [] },
    { source: "dbo.Ministry", id: "M1", names: ["Hon. Dorian Feld"], email: "dorian.feld@gov.example", phones: [] },
    { source: "media.Contact", id: "7", names: ["Dorian Feld"], email: "dfeld@news.example", phones: [] },
    { source: "calendar.GovernmentRepresentative", id: "2", names: ["Hon. Wren Talbot"], email: null, phones: [] },
  ], "f".repeat(64));
  const needles = buildLiteralNeedles(index);
  const kinds = (text: string) => literalHits(text, needles).map((h) => `${h.kind}${h.publicOffice ? " (public office)" : ""}`);

  it("catches a person the parser can't index", () => {
    expect(parseName(UNPARSED)).toBeNull();
    expect([...index.byVariant.keys()].some((k) => k.includes("okonkwo ruiz"))).toBe(false);
    expect(kinds(`Met ${UNPARSED}.`)).toEqual(["literal-name"]);
  });

  it("reads entities, case, accents, tags and any run of whitespace", () => {
    expect(kinds("QUILL&nbsp;\n  ashbury")).toEqual(["literal-name"]);
    expect(kinds("Ashbury ,Quill")).toEqual(["literal-name"]);
    expect(kinds("<b>Quill</b> Ashbury")).toEqual(["literal-name"]);
    expect(kinds('<img alt="Quill Ashbury" src="x.png">')).toEqual(["literal-name"]);
    expect(kinds("Q&#117;ill Ashb&uacute;ry")).toEqual(["literal-name"]);
  });

  it("matches whole words only, and never a single word", () => {
    expect(kinds("Quill Ashburyton")).toEqual([]);
    expect(kinds("Tranquill Ashbury")).toEqual([]);
    expect(kinds("Ashbury said so. Admin approved.")).toEqual([]);
    expect(kinds("Quill Ashbury's plan")).toEqual(["literal-name"]);
  });

  it("finds real emails however they are written", () => {
    expect(kinds("Write QUILL.ASHBURY@gov.example now")).toEqual(["literal-email"]);
    expect(kinds("quill&#46;ashbury&#64;gov.example")).toEqual(["literal-email"]);
    expect(kinds("xquill.ashbury@gov.example")).toEqual([]);
  });

  it("finds real phones in any layout, but not the fictional range", () => {
    expect(kinds("Call 604 555 0142")).toEqual(["literal-phone"]);
    expect(kinds("Call 1-604-555-0142 or (604)555-0142")).toEqual(["literal-phone", "literal-phone"]);
    expect(kinds("Call 250-555-0142, 250-555-0161 or 555-0177")).toEqual([]);
  });

  it("lets a public office holder's name through but not their email", () => {
    expect(kinds(`${MINISTER} spoke`)).toEqual(["literal-name (public office)"]);
    expect(kinds("Hon. Wren Talbot and Wren Talbot")).toEqual(["literal-name (public office)", "literal-name (public office)"]);
    expect(kinds("Write okonkwo-bell@gov.example")).toEqual(["literal-email"]);
  });

  it("counts a name shared with someone who isn't an office holder as a leak", () => {
    expect(kinds("Dorian Feld called")).toEqual(["literal-name"]);
  });
});

const cfg = mssqlTestConfig();
if (!cfg) console.warn(SKIP_MESSAGE);

describe.skipIf(!cfg)("people and text on a fictional SQL Server fixture", () => {
  let fx: Awaited<ReturnType<typeof createFixture>>;
  let index: PeopleIndex;
  const q = async <T>(text: string) => (await fx.pool.request().query<T>(text)).recordset;

  beforeAll(async () => {
    fx = await createFixture(cfg!);
    index = buildPeopleIndex(await readPeopleSources(fx.pool), FIXTURE_KEY, new Set(["editor@example.test"]));
    await applyScope(fx.pool, REF_UTC, REF_WALL);
    await emptyTables(fx.pool);
  }, 120_000);
  afterAll(async () => { await fx?.drop(); });

  it("finds people in every source table, journalists included", () => {
    expect(index.bySource.get("calendar.SystemUser:1")).toBe(index.bySource.get("dbo.User:" + "80000000-0000-4000-8000-000000000001".toUpperCase()));
    expect(index.byVariant.has("wynona brightwater")).toBe(true);
    expect(index.bySource.has("calendar.GovernmentRepresentative:2")).toBe(false);
  });

  it("rewrites structured people columns with fictional identities", async () => {
    await writeStructuredPeople(fx.pool, index);
    const quill = index.bySource.get("calendar.SystemUser:1")!.fake;
    const u = (await q<{ FullName: string; DisplayName: string; EmailAddress: string; PhoneNumber: string; MobileNumber: string; Username: string }>("SELECT FullName, DisplayName, EmailAddress, PhoneNumber, MobileNumber, Username FROM calendar.SystemUser WHERE Id = 1"))[0]!;
    expect(u).toEqual({ FullName: quill.full, DisplayName: quill.full, EmailAddress: quill.email, PhoneNumber: quill.phone, MobileNumber: quill.phone, Username: quill.username });
    expect((await q<{ Name: string }>("SELECT Name FROM calendar.CommunicationContact WHERE Id = 1"))[0]!.Name).toBe(quill.full);
    expect((await q<{ Name: string }>("SELECT Name FROM calendar.GovernmentRepresentative WHERE Id = 2"))[0]!.Name).toBe("Premier");
    expect((await q<{ EmailAddress: string }>("SELECT EmailAddress FROM calendar.SystemUser WHERE Id = 4"))[0]!.EmailAddress).toMatch(/^invalid-\d+$/);
    expect((await q<{ DisplayName: string; EmailAddress: string | null }>("SELECT DisplayName, EmailAddress FROM calendar.SystemUser WHERE Id = 3"))[0]!.EmailAddress).toBeNull();
  });

  it("scrubs every text column and passes the gate", async () => {
    await scrubAllText(fx.pool, { index, key: FIXTURE_KEY });
    const gate = await gateMssql(fx.pool, index);
    expect(gate.hits).toEqual([]);
    expect(gate.publicOfficeHits).toBe(0);
    const a = (await q<{ Title: string; Comments: string }>("SELECT Title, Comments FROM calendar.Activity WHERE Id = 1"))[0]!;
    expect(a.Title).not.toMatch(/Quill|Ashbury/);
    expect(a.Comments).toMatch(/person\d+@example\.test/);
    expect(a.Comments).toMatch(/555-01\d\d/);
    expect((await q<{ Key: string }>("SELECT [Key] FROM dbo.NewsRelease ORDER BY [Key]")).map((r) => r.Key)).toEqual(["2026HLTH0001-000001", "2026HLTH0004-000004"]);
  });

  it("fits a longer replacement to the column", async () => {
    const d = (await q<{ Description: string }>("SELECT Description FROM calendar.GovernmentRepresentative WHERE Id = 3"))[0]!.Description;
    expect(d).toHaveLength(84);
    expect(d).not.toContain("gov.example");
  });

  it("a second pass changes nothing", async () => {
    const again = await scrubAllText(fx.pool, { index, key: FIXTURE_KEY });
    for (const [table, r] of Object.entries(again)) expect(r.changed, table).toBe(0);
  });

  it("fails the gate on a planted name", async () => {
    await fx.pool.request().query("UPDATE calendar.Activity SET Comments = N'Quill Ashbury called' WHERE Id = 5");
    const gate = await gateMssql(fx.pool, index);
    expect(gate.hits).toEqual(expect.arrayContaining([{ table: "calendar.Activity", column: "Comments", kind: "name", count: 1 }, { table: "calendar.Activity", column: "Comments", kind: "name-plain", count: 1 }]));
    expect(gate.rows).toContainEqual({ table: "calendar.Activity", column: "Comments", kind: "name", id: "5" });
  });
});

describe.skipIf(!cfg)("Gate 1's literal route on a fictional SQL Server fixture", () => {
  let fx: Awaited<ReturnType<typeof createFixture>>;
  let index: PeopleIndex;
  const plant = async (comments: string) => {
    await fx.pool.request().input("c", comments).query("UPDATE calendar.Activity SET Comments = @c WHERE Id = 5");
    return gateMssql(fx.pool, index);
  };

  beforeAll(async () => {
    fx = await createFixture(cfg!);
    await fx.pool.request().input("n", UNPARSED).query("INSERT calendar.SystemUser (Id, Username, FullName, DisplayName, EmailAddress) VALUES (5, N'xruiz', @n, @n, N'ximena.ruiz@gov.example')");
    await fx.pool.request().input("n", MINISTER).query("INSERT dbo.Ministry (Id, [Key], MinisterName, MinisterEmail) VALUES ('70000000-0000-4000-8000-000000000002', N'tourism', @n, N'okonkwo-bell@gov.example')");
    index = buildPeopleIndex(await readPeopleSources(fx.pool), FIXTURE_KEY, new Set(["editor@example.test"]));
    await applyScope(fx.pool, REF_UTC, REF_WALL);
    await emptyTables(fx.pool);
    await writeStructuredPeople(fx.pool, index);
    await scrubAllText(fx.pool, { index, key: FIXTURE_KEY });
  }, 120_000);
  afterAll(async () => { await fx?.drop(); });

  it("starts clean", async () => {
    const gate = await gateMssql(fx.pool, index);
    expect(gate.hits).toEqual([]);
    expect(gate.publicOfficeHits).toBe(0);
  });

  it("fails on a person the parser can't index, through the literal route alone", async () => {
    expect(parseName(UNPARSED)).toBeNull();
    const gate = await plant(`Met ${UNPARSED} at noon`);
    expect(gate.hits).toEqual([{ table: "calendar.Activity", column: "Comments", kind: "literal-name", count: 1 }]);
    expect(gate.rows).toEqual([{ table: "calendar.Activity", column: "Comments", kind: "literal-name", id: "5" }]);
  });

  it("counts a public office holder's name without failing", async () => {
    const gate = await plant(`${MINISTER} spoke`);
    expect(gate.hits).toEqual([]);
    expect(gate.publicOffice).toEqual([{ table: "calendar.Activity", column: "Comments", kind: "literal-name", count: 1 }]);
    expect(gate.publicOfficeHits).toBe(1);
  });

  it("fails on a public office holder's email", async () => {
    const gate = await plant("Write to okonkwo-bell@gov.example");
    expect(gate.hits).toEqual(expect.arrayContaining([{ table: "calendar.Activity", column: "Comments", kind: "literal-email", count: 1 }]));
    expect(gate.publicOfficeHits).toBe(0);
  });

  it("fails on a real phone", async () => {
    const gate = await plant("Call 604 555 0142");
    expect(gate.hits).toEqual(expect.arrayContaining([{ table: "calendar.Activity", column: "Comments", kind: "literal-phone", count: 1 }]));
  });

  it("keeps people out of its progress lines", async () => {
    const lines: string[] = [];
    await plant(`Met ${UNPARSED}; ${MINISTER} spoke`);
    await gateMssql(fx.pool, index, (l) => lines.push(l));
    expect(lines.length).toBeGreaterThan(0);
    const people = index.persons.flatMap((p) => [p.key, ...p.names, ...p.emails, ...p.phones, p.fake.full, p.fake.email]);
    for (const l of lines) for (const v of people) expect(l.toLowerCase()).not.toContain(v.toLowerCase());
  });
});
