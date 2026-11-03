import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScrubArgs } from "../../scripts/lib/scrub/args";
import { ScrubArgumentError } from "../../scripts/lib/scrub/private-out";

const base = ["--backup", "/backup/Hub_TEST.bak", "--out", "/p/runs"];
const repoKeyFile = resolve(import.meta.dirname, "..", "..", "repo-key");

describe("parseScrubArgs", () => {
  it("fills the defaults, including a --key-file inside the private root", () => {
    const o = parseScrubArgs(base, "/p");
    expect(o).toMatchObject({ backup: "/backup/Hub_TEST.bak", out: "/p/runs", keyFile: join("/p", "scrub-key"), scrubbedDb: "Gcpe.Hub_Scrubbed", calendarCutoff: "2000-01-01", site: "https://boxs.ca", sshHost: "boxs", stopAfter: "load", calendarUser: "cal-hq-editor@example.test", releaseUser: "editor@example.test", leadDays: 14 });
  });

  it("requires --backup and --out", () => {
    expect(() => parseScrubArgs(["--out", "/p/x"], "/p")).toThrow(/--backup/);
    expect(() => parseScrubArgs(["--backup", "/b/x.bak"], "/p")).toThrow(/--out/);
  });

  it.each([
    [["--backup", "relative.bak"], /absolute/],
    [["--backup", "/b/../x.bak"], /absolute/],
    [["--scrubbed-db", "Gcpe.Hub"], /_Scrubbed/],
    [["--calendar-cutoff", "2026-02-30"], /YYYY-MM-DD/],
    [["--site", "http://boxs.ca"], /https/],
    [["--ssh-host", "boxs; rm -rf ~"], /--ssh-host/],
    [["--stop-after", "everything"], /--stop-after/],
    [["--calendar-user", "not-an-email"], /--calendar-user/],
    [["--key-file", join(tmpdir(), "elsewhere-key")], /--key-file/],
    [["--key-file", repoKeyFile], /--key-file/],
    [["--nope"], /Unknown argument/],
  ])("rejects %j", (extra, message) => {
    const argv = [...base.filter((_, i) => !(extra[0] === "--backup" && (i === 0 || i === 1))), ...extra];
    expect(() => parseScrubArgs(argv, "/p")).toThrow(ScrubArgumentError);
    expect(() => parseScrubArgs(argv, "/p")).toThrow(message);
  });
});
