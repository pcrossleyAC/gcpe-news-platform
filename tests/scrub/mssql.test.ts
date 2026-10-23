import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScope, assertRequiredTables, assertScrubCopy, emptyTables, openPool, restorePlan, shiftCalendarDates, tableCounts } from "../../scripts/lib/scrub/mssql";
import { createFixture, ID, mssqlTestConfig, REF_UTC, REF_WALL, SKIP_MESSAGE } from "./mssql-fixture";

describe("restorePlan", () => {
  it("moves each file next to the server's own and refuses other names", () => {
    const p = restorePlan("Gcpe.Hub_Scrubbed", [{ LogicalName: "Gcpe.Hub", Type: "D" }, { LogicalName: "Gcpe.Hub_log", Type: "L" }], "/var/opt/mssql/data/", "/var/opt/mssql/data");
    expect(p.sql).toBe("RESTORE DATABASE @db FROM DISK = @backup WITH MOVE @l0 TO @f0, MOVE @l1 TO @f1, REPLACE, RECOVERY, STATS = 10;");
    expect(p.params).toEqual({ db: "Gcpe.Hub_Scrubbed", l0: "Gcpe.Hub", f0: "/var/opt/mssql/data/Gcpe.Hub_Scrubbed_0.mdf", l1: "Gcpe.Hub_log", f1: "/var/opt/mssql/data/Gcpe.Hub_Scrubbed_1.ldf" });
    expect(() => restorePlan("Gcpe.Hub", [], "/d", "/l")).toThrow(/_Scrubbed/);
  });
});

const cfg = mssqlTestConfig();
if (!cfg) console.warn(SKIP_MESSAGE);

describe.skipIf(!cfg)("on a fictional SQL Server fixture", () => {
  let fx: Awaited<ReturnType<typeof import("./mssql-fixture").createFixture>>;
  beforeAll(async () => { fx = await createFixture(cfg!); }, 120_000);
  afterAll(async () => { await fx?.drop(); });
  const q = async <T>(text: string) => (await fx.pool.request().query<T>(text)).recordset;

  it("refuses to write anywhere but a _Scrubbed database", async () => {
    await assertScrubCopy(fx.pool);
    const master = await openPool(cfg!, "master");
    try { await expect(assertScrubCopy(master)).rejects.toThrow(/_Scrubbed/); } finally { await master.close(); }
  });

  it("finds every required table", async () => { await assertRequiredTables(fx.pool); });

  it("scopes releases, activities and carousels", async () => {
    await applyScope(fx.pool, REF_UTC, REF_WALL);
    expect((await q<{ Id: number }>("SELECT Id FROM calendar.Activity ORDER BY Id")).map((r) => r.Id)).toEqual([1, 5]);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.ActivityCategories WHERE ActivityId NOT IN (1, 5)"))[0]!.n).toBe(0);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.FavoriteActivity"))[0]!.n).toBe(1);
    expect((await q<{ Id: number }>("SELECT Id FROM calendar.Log ORDER BY Id")).map((r) => r.Id)).toEqual([1, 2]);
    const releases = await q<{ Id: string; ActivityId: number | null }>("SELECT CAST(Id AS nvarchar(50)) AS Id, ActivityId FROM dbo.NewsRelease ORDER BY Id");
    expect(releases).toEqual([{ Id: ID.R1.toUpperCase(), ActivityId: 1 }, { Id: ID.R4.toUpperCase(), ActivityId: null }]);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.NewsReleaseDocumentContact"))[0]!.n).toBe(1);
    const m = (await q<{ Top: string | null; Feature: string | null }>("SELECT CAST(TopReleaseId AS nvarchar(50)) AS [Top], CAST(FeatureReleaseId AS nvarchar(50)) AS Feature FROM dbo.Ministry"))[0]!;
    expect(m).toEqual({ Top: null, Feature: ID.R1.toUpperCase() });
    expect((await q<{ T: string | null }>("SELECT CAST(TopReleaseId AS nvarchar(50)) AS T FROM dbo.Sector"))[0]!.T).toBeNull();
    const settings = Object.fromEntries((await q<{ SettingName: string; SettingValue: string }>("SELECT SettingName, SettingValue FROM dbo.ApplicationSetting")).map((r) => [r.SettingName, r.SettingValue]));
    expect(settings.HomeTopReleaseId).toBe("");
    expect(settings.HomeFeatureReleaseId).toBe(ID.R1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.Carousel"))[0]!.n).toBe(1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.Slide"))[0]!.n).toBe(1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.NewsFeed"))[0]!.n).toBe(0);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.ActivityFiles"))[0]!.n).toBe(0);
  });

  it("empties the tables no importer reads", async () => {
    const emptied = await emptyTables(fx.pool);
    expect(emptied).toEqual(expect.arrayContaining(["media.Contact", "dashboard.UserMinistryPreference", "dbo.NewsReleaseHistory", "dbo.MediaRequestResolution"]));
    const counts = await tableCounts(fx.pool);
    for (const t of emptied) expect(counts[t], t).toBe(0);
    expect(counts["dbo.Blob"]).toBe(1);
  });

  it("shifts every calendar date by whole weeks, clamping stamps but not event dates", async () => {
    const r = await shiftCalendarDates(fx.pool, REF_WALL, 14);
    expect(r.weeks).toBe(3);
    const a = (await q<{ StartDateTime: Date; EndDateTime: Date; NRDateTime: Date; CreatedDateTime: Date; LastUpdatedDateTime: Date }>("SELECT StartDateTime, EndDateTime, NRDateTime, CreatedDateTime, LastUpdatedDateTime FROM calendar.Activity WHERE Id = 1"))[0]!;
    expect(a.EndDateTime.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(a.StartDateTime.getUTCDay()).toBe(1);
    expect(a.CreatedDateTime.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect((await q<{ OldValue: string }>("SELECT OldValue FROM calendar.Log WHERE Id = 1"))[0]!.OldValue).toBe("10/26/2026 9:00:00 AM");
    expect(r.logText).toEqual({ shifted: 1, unparsed: 0 });

    // The shift puts Activity 1's LastUpdatedDateTime (2026-10-05 + 3 weeks = 2026-10-26, a stamp
    // column) after the reference time (2026-10-22 12:00), so it is clamped down to the reference.
    // Its EndDateTime and NRDateTime shift to the same future week but are event dates, not stamps,
    // so the shift leaves them exactly where it put them.
    expect(a.LastUpdatedDateTime.toISOString()).toBe(REF_WALL.toISOString());
    expect(a.EndDateTime.getTime()).toBeGreaterThan(REF_WALL.getTime());
    expect(a.NRDateTime.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(a.NRDateTime.getTime()).toBeGreaterThan(REF_WALL.getTime());

    // calendar.Log's own CreatedDateTime/LastUpdatedDateTime (distinct from the OldValue/NewValue
    // text checked above) land on 2026-10-26 too, and are clamped the same way.
    const log = await q<{ Id: number; CreatedDateTime: Date; LastUpdatedDateTime: Date }>("SELECT Id, CreatedDateTime, LastUpdatedDateTime FROM calendar.Log ORDER BY Id");
    for (const row of log) {
      expect(row.CreatedDateTime.toISOString(), `Log ${row.Id} CreatedDateTime`).toBe(REF_WALL.toISOString());
      expect(row.LastUpdatedDateTime.toISOString(), `Log ${row.Id} LastUpdatedDateTime`).toBe(REF_WALL.toISOString());
    }

    // Exactly the 5 stamp values above (Activity.LastUpdatedDateTime, and Log's two rows' Created-
    // and LastUpdatedDateTime) were pushed past the reference time and clamped; nothing else was.
    expect(r.clamped).toBe(5);
  });
});
