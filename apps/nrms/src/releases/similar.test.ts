import { afterEach, describe, expect, it, vi } from "vitest";
import { view } from "@gcpe/nrms-contract/testing";
import type { Db } from "@gcpe/db-kit";
import type { NewsApiSimilarClient, SimilarRequestBody } from "../clients";
import { findSimilar, similarSource } from "./similar";

const MARKER = "quokkadraftmarker";
const noDb = undefined as unknown as Db;

describe("similarSource", () => {
  it("is the English headline, summary, keywords and every document's body as one line; terms are headline and keywords", () => {
    const v = view({
      keywords: "clinics, weekends",
      documents: [
        { ...view().documents[0]!, sortIndex: 1, languages: [{ ...view().documents[0]!.languages[0]!, headline: "Second doc", bodyHtml: "<p>Backgrounder&nbsp;text.</p>" }] },
        { ...view().documents[0]!, id: "d0", sortIndex: 0, languages: [{ ...view().documents[0]!.languages[0]!, headline: "Clinics open", bodyHtml: "<p>Clinics will open.</p>\n<p>More.</p>" }] },
      ],
    });
    expect(similarSource(v)).toEqual({ text: "Clinics open Clinics open. clinics, weekends Clinics will open. More. Backgrounder text.", terms: "Clinics open clinics, weekends" });
  });

  it("caps the text at 8,000 code points and the terms at 1,000", () => {
    const long = "é".repeat(9000);
    const v = view({ keywords: long, languages: [{ ...view().languages[0]!, summary: "" }], documents: [] });
    const s = similarSource(v);
    expect(Array.from(s.text)).toHaveLength(8000);
    expect(Array.from(s.terms)).toHaveLength(1000);
  });
});

describe("findSimilar", () => {
  afterEach(() => vi.restoreAllMocks());
  const client = (impl: NewsApiSimilarClient["similar"]) => {
    const calls: SimilarRequestBody[] = [];
    return { calls, client: { similar: async (b: SimilarRequestBody) => (calls.push(b), impl(b)) } };
  };

  it("a blank draft is refused without a call", async () => {
    const c = client(async () => ({ mode: "text", results: [] }));
    const blank = view({ keywords: null, languages: [{ ...view().languages[0]!, summary: "" }], documents: [] });
    expect(await findSimilar(noDb, blank, { client: c.client, staffAi: true })).toEqual({ kind: "empty" });
    expect(c.calls).toEqual([]);
  });

  it.each([
    [false, "text"],
    [true, "ai"],
  ] as const)("NRMS staffAi=%s sends mode %s, and excludeKey is the release's key", async (staffAi, mode) => {
    const c = client(async () => ({ mode: "text", results: [] }));
    await findSimilar(noDb, view({ key: "2026HLTH0001-000001" }), { client: c.client, staffAi });
    expect(c.calls[0]).toMatchObject({ mode, excludeKey: "2026HLTH0001-000001" });
    expect(c.calls[0]?.text).toContain("Clinics open");
  });

  it("a News API failure is 'failed', and nothing logs the draft", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const c = client(async () => {
      throw new Error(`boom ${MARKER}`);
    });
    const v = view({ keywords: MARKER });
    expect(await findSimilar(noDb, v, { client: c.client, staffAi: false })).toEqual({ kind: "failed" });
    expect(lines.length).toBe(1);
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain("Clinics open");
  });
});
