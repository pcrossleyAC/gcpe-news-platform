// Production configuration T6 (owner approved 2026-10-31): Import-GcpeLegacy.ps1's Nrms and Nod
// steps sign in as the break-glass admin to make Core and NRMS republish. With break-glass off (the
// real production site after go-live) the script must stop before it imports anything, saying why,
// rather than import half the data and fail at the sign-in. PowerShell isn't run here (no pwsh on
// the test machines); this pins the check's place and wording in the script's text.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Import-GcpeLegacy.ps1 without the break-glass admin", () => {
  it("stops before the first importer when the Nrms or Nod step is chosen and LOCAL_ADMIN_ENABLED isn't true", async () => {
    const src = await readFile(join(__dirname, "../deploy/windows/Import-GcpeLegacy.ps1"), "utf8");
    const guard = src.indexOf("$envValues['LOCAL_ADMIN_ENABLED'] -ne 'true'");
    expect(guard, "the break-glass check").toBeGreaterThan(-1);
    const firstWork = Math.min(...["Wait-GcpeHealth", "Invoke-Importer '", "Read-Host \"Password for SQL Server"].map((s) => src.indexOf(s)).filter((i) => i > -1));
    expect(guard).toBeLessThan(firstWork);
    const line = src.slice(src.lastIndexOf("\n", guard), src.indexOf("\n", guard));
    expect(line).toMatch(/if \(\$needsBreakGlass -and /);
    expect(src).toContain("$needsBreakGlass = $Only -contains 'Nrms' -or $Only -contains 'Nod'");
    expect(src).toMatch(/throw "The Nrms and Nod steps sign in as the break-glass admin/);
    expect(src).toMatch(/Run the import before go-live/);
  });
});
