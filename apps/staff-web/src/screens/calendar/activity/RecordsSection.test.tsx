import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityFileView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG } from "../list/fixtures";
import { renderActivity, stubActivity, view, type Call } from "./fixtures";

const FILE: ActivityFileView = { id: 5, fileName: "Sample brief.pdf", contentType: "application/pdf", length: 2048, uploadedAt: "2026-11-02T17:00:00.000Z", uploadedByName: "Robin Staff" };
const FILES = "/calendar/api/activities/20001/files";
const ON = { ...CONFIG, showRecordsSection: true };
const ACTIVITY = "/calendar/api/activities/20001";
const sent = (calls: Call[]) => calls.filter((c) => c.url === FILES && c.init?.method === "POST").map((c) => decodeURIComponent(new Headers(c.init!.headers).get("X-GCPE-File-Name")!));
const sized = (name: string, size: number) => {
  const f = new File(["%PDF"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("Records (spec addendum §8.2, §8.4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is hidden when the tenant hides it and the activity has no files (Q51)", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("group", { name: "Records" })).toBeNull();
  });

  it("shows an activity's files, each downloaded through the authorised route", async () => {
    stubActivity([], { config: ON, view: view({ files: [FILE] }) });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).getByRole("link", { name: "Sample brief.pdf" })).toHaveAttribute("href", `${FILES}/5`);
    expect(records).toHaveTextContent("2 KB, added Nov 2, 2026 by Robin Staff");
  });

  it("adds several files one by one, taking the lock first; one refused file doesn't stop the others", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      config: { ...CONFIG, showRecordsSection: true },
      other: (url, init) => {
        if (url !== FILES || init?.method !== "POST") return undefined;
        const name = decodeURIComponent(new Headers(init.headers).get("X-GCPE-File-Name") ?? "");
        if (name === "Sample.exe") return jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "files", message: "This type of file can't be attached." }] });
        return jsonResponse(201, [FILE, { ...FILE, id: 6, fileName: "Sample notes.txt", contentType: "text/plain", length: 12 }]);
      },
    });
    renderActivity("/calendar/activities/20001");
    const input = await screen.findByLabelText("Add files");
    // The picker's accept attribute would hide the .exe; a user can still choose "All files", and the server decides.
    await userEvent.setup({ applyAccept: false }).upload(input, [new File(["notes"], "Sample notes.txt", { type: "text/plain" }), new File(["MZ"], "Sample.exe")]);
    const records = screen.getByRole("group", { name: "Records" });
    expect(await within(records).findByRole("link", { name: "Sample notes.txt" })).toBeInTheDocument();
    expect(within(records).getByRole("alert")).toHaveTextContent("Sample.exe: This type of file can't be attached.");
    expect(within(records).getByRole("status")).toHaveTextContent("Added 1 file.");
    const lockAt = calls.findIndex((c) => c.url.endsWith("/lock"));
    const firstUpload = calls.findIndex((c) => c.url === FILES);
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstUpload);
    expect(calls[firstUpload]!.init!.body).toBeInstanceOf(File);
    expect(new Headers(calls[firstUpload]!.init!.headers).get("X-GCPE-File-Name")).toBe(encodeURIComponent("Sample notes.txt"));
  });

  it("refuses a file over 25 MB without sending it", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { config: { ...CONFIG, showRecordsSection: true } });
    renderActivity("/calendar/activities/20001");
    const big = new File(["x"], "Sample big.pdf");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    await userEvent.upload(await screen.findByLabelText("Add files"), big);
    expect(await screen.findByText("Sample big.pdf: A file can be at most 25 MB.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === FILES)).toBe(false);
  });

  it("removes a file after asking", async () => {
    stubActivity([], {
      config: ON,
      view: view({ files: [FILE] }),
      other: (url, init) => (url === `${FILES}/5` && init?.method === "DELETE" ? jsonResponse(200, []) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Sample brief.pdf" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Remove Sample brief.pdf?" })).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed Sample brief.pdf.")).toBeInTheDocument();
    expect(screen.getByText("No files yet.")).toBeInTheDocument();
  });

  it("a read-only viewer can download but not add or remove", async () => {
    stubActivity([], { config: ON, view: view({ files: [FILE], can: { edit: false, clone: false, delete: false, review: false } }) });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).getByRole("link", { name: "Sample brief.pdf" })).toBeInTheDocument();
    expect(within(records).queryByLabelText("Add files")).toBeNull();
    expect(within(records).queryByRole("button", { name: "Remove Sample brief.pdf" })).toBeNull();
  });

  it("a new activity says to save first when Records is on", async () => {
    stubActivity([], { config: { ...CONFIG, showRecordsSection: true } });
    renderActivity("/calendar/activities/new");
    expect(await screen.findByText("Save the activity first to add files.")).toBeInTheDocument();
  });

  it("an upload keeps unsaved changes and the version they were based on", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      config: { ...CONFIG, showRecordsSection: true },
      other: (url, init) => {
        if (url === FILES && init?.method === "POST") return jsonResponse(201, [FILE]);
        if (url === "/calendar/api/activities/20001" && init?.method === "PUT") return jsonResponse(200, { id: 20001, activity: view({ version: 4 }), warnings: [] });
        return undefined;
      },
    });
    renderActivity("/calendar/activities/20001");
    const title = await screen.findByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Sample renamed");
    await userEvent.upload(screen.getByLabelText("Add files"), new File(["%PDF"], "Sample brief.pdf"));
    expect(await screen.findByRole("link", { name: "Sample brief.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Sample list" });
    const put = calls.find((c) => c.url === "/calendar/api/activities/20001" && c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init!.body))).toMatchObject({ title: "Sample renamed", version: 3 });
  });

  it("a file write refused by the freeze or a lock is said once, by the lock's banner", async () => {
    stubActivity([], {
      config: { ...CONFIG, showRecordsSection: true },
      other: (url, init) =>
        url === FILES && init?.method === "POST" ? jsonResponse(423, { code: "freeze", error: "You cannot make content changes between 4pm-5pm." }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), new File(["%PDF"], "Sample brief.pdf"));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot make content changes between 4pm-5pm.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Records" })).queryByRole("alert")).toBeNull();
  });

  it("under someone else's lock, nothing is sent and the file controls are gone", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      config: { ...CONFIG, showRecordsSection: true },
      view: view({ files: [FILE], lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }),
    });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).getByRole("link", { name: "Sample brief.pdf" })).toBeInTheDocument();
    expect(within(records).queryByLabelText("Add files")).toBeNull();
    expect(within(records).queryByRole("button", { name: "Remove Sample brief.pdf" })).toBeNull();
  });

  it("the freeze hides adding and removing", async () => {
    stubActivity([], { config: { ...CONFIG, showRecordsSection: true, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } }, view: view({ files: [FILE] }) });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).queryByLabelText("Add files")).toBeNull();
    expect(within(records).queryByRole("button", { name: "Remove Sample brief.pdf" })).toBeNull();
  });

  it("is hidden while the tenant hides it, even when the activity has files, as legacy (Q51)", async () => {
    stubActivity([], { view: view({ files: [FILE] }) });
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("group", { name: "Records" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sample brief.pdf" })).toBeNull();
  });

  it("a reload while there are unsaved changes takes the server's files, keeping the changes", async () => {
    let phase = 0;
    stubActivity([], {
      config: ON,
      view: () => (phase === 0 ? view({ files: [FILE] }) : view({ files: [], lock: null })),
      other: (url, init) => {
        if (url !== ACTIVITY || init?.method !== "PUT") return undefined;
        phase = 1;
        return jsonResponse(423, { code: "locked", error: "Sample Admin is editing", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } });
      },
    });
    vi.useFakeTimers({ toFake: ["setInterval"] });
    try {
      renderActivity("/calendar/activities/20001");
      await userEvent.type(await screen.findByRole("textbox", { name: "Title" }), " x");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Sample Admin is editing this activity", { exact: false });
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      await screen.findByLabelText("Add files");
      expect(screen.queryByRole("link", { name: "Sample brief.pdf" })).toBeNull();
      expect(screen.getByText("No files yet.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample activity x");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removing a file someone else already removed takes it off the list, keeping unsaved changes", async () => {
    stubActivity([], {
      config: ON,
      view: view({ files: [FILE] }),
      other: (url, init) => (url === `${FILES}/5` && init?.method === "DELETE" ? jsonResponse(404, { error: "not found" }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Title" }), " x");
    await userEvent.click(screen.getByRole("button", { name: "Remove Sample brief.pdf" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Remove Sample brief.pdf?" })).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("That file was already removed.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sample brief.pdf" })).toBeNull();
    expect(screen.queryByText("This activity is no longer available.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample activity x");
  });

  it.each([
    ["an upload", "POST"],
    ["a remove", "DELETE"],
  ])("%s answered \"deleted\" says so once and makes the page read-only, as Save does", async (_what, method) => {
    stubActivity([], {
      config: ON,
      view: view({ files: [FILE] }),
      other: (url, init) => (url.startsWith(FILES) && init?.method === method ? jsonResponse(409, { code: "deleted", error: "This activity has been deleted." }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    if (method === "POST") await userEvent.upload(await screen.findByLabelText("Add files"), new File(["%PDF"], "Sample notes.pdf"));
    else {
      await userEvent.click(await screen.findByRole("button", { name: "Remove Sample brief.pdf" }));
      await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Remove Sample brief.pdf?" })).getByRole("button", { name: "Remove" }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("This activity has been deleted.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.queryByLabelText("Add files")).toBeNull();
    expect(screen.getByRole("link", { name: "Sample brief.pdf" })).toBeInTheDocument();
  });

  it("sends a file of exactly 25 MB and refuses one a byte over", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { config: ON, other: (url, init) => (url === FILES && init?.method === "POST" ? jsonResponse(201, [FILE]) : undefined) });
    renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), [sized("Sample exact.pdf", 25 * 1024 * 1024), sized("Sample over.pdf", 25 * 1024 * 1024 + 1)]);
    expect(await screen.findByText("Sample over.pdf: A file can be at most 25 MB.")).toBeInTheDocument();
    expect(sent(calls)).toEqual(["Sample exact.pdf"]);
  });

  it("a batch stopped by the freeze names the files that didn't get in", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      config: ON,
      other: (url, init) => {
        if (url !== FILES || init?.method !== "POST") return undefined;
        return sent(calls).length === 1 ? jsonResponse(201, [FILE]) : jsonResponse(423, { code: "freeze", error: "You cannot make content changes between 4pm-5pm." });
      },
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), [new File(["%PDF"], "Sample a.pdf"), new File(["%PDF"], "Sample b.pdf"), new File(["%PDF"], "Sample c.pdf")]);
    await screen.findByText("You cannot make content changes between 4pm-5pm.");
    expect(sent(calls)).toEqual(["Sample a.pdf", "Sample b.pdf"]);
    const records = screen.getByRole("group", { name: "Records" });
    expect(within(records).getByRole("alert")).toHaveTextContent("Not added: Sample b.pdf, Sample c.pdf.");
    expect(within(records).getByRole("status")).toHaveTextContent("Added 1 file.");
  });

  it("refuses files past the 50-file limit before sending them, letting a same-name replacement through", async () => {
    const calls: Call[] = [];
    const full = Array.from({ length: 49 }, (_, i) => ({ ...FILE, id: 100 + i, fileName: `Sample ${i}.pdf` }));
    stubActivity(calls, {
      config: ON,
      view: view({ files: full }),
      other: (url, init) => (url === FILES && init?.method === "POST" ? jsonResponse(201, [...full, { ...FILE, id: 200, fileName: "Sample new.pdf" }]) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), [new File(["%PDF"], "Sample new.pdf"), new File(["%PDF"], "Sample more.pdf"), new File(["%PDF"], "SAMPLE 3.PDF")]);
    expect(await screen.findByText("Sample more.pdf: An activity holds at most 50 files. Remove one first.")).toBeInTheDocument();
    expect(sent(calls)).toEqual(["Sample new.pdf", "SAMPLE 3.PDF"]);
  });

  it("after the server's own 50-file refusal, sends only same-name replacements", async () => {
    const calls: Call[] = [];
    const LIMIT = { error: "Fix the fields named", errors: [{ field: "files", message: "An activity holds at most 50 files. Remove one first." }] };
    stubActivity(calls, {
      config: ON,
      view: view({ files: [FILE] }),
      other: (url, init) => {
        if (url !== FILES || init?.method !== "POST") return undefined;
        return sent(calls).at(-1) === "Sample brief.pdf" ? jsonResponse(201, [FILE]) : jsonResponse(422, LIMIT);
      },
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), [new File(["%PDF"], "Sample a.pdf"), new File(["%PDF"], "Sample b.pdf"), new File(["%PDF"], "Sample brief.pdf")]);
    expect(await screen.findByText("Sample b.pdf: An activity holds at most 50 files. Remove one first.")).toBeInTheDocument();
    expect(screen.getByText("Sample a.pdf: An activity holds at most 50 files. Remove one first.")).toBeInTheDocument();
    expect(sent(calls)).toEqual(["Sample a.pdf", "Sample brief.pdf"]);
  });

  it("after a remove, the keyboard lands on Add files", async () => {
    const OTHER = { ...FILE, id: 6, fileName: "Sample other.pdf" };
    stubActivity([], {
      config: ON,
      view: view({ files: [FILE, OTHER] }),
      other: (url, init) => (url === `${FILES}/5` && init?.method === "DELETE" ? jsonResponse(200, [OTHER]) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Sample brief.pdf" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Remove Sample brief.pdf?" })).getByRole("button", { name: "Remove" }));
    await screen.findByText("Removed Sample brief.pdf.");
    await waitFor(() => expect(screen.getByLabelText("Add files")).toHaveFocus());
  });
});
