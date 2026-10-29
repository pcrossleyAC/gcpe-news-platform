import { describe, expect, it } from "vitest";
import { extractFileReferences, KNOWN_LEGACY_FILES, legacyCandidates, normalizeLegacyPath, parsePathsFile } from "./references";

describe("normalizeLegacyPath", () => {
  it("decodes each segment and keeps the case", () => {
    expect(normalizeLegacyPath("News_Footage_License_British_Columbia.pdf")).toEqual({ ok: true, path: "News_Footage_License_British_Columbia.pdf" });
    expect(normalizeLegacyPath("Q1_%20MediaDeck.pdf")).toEqual({ ok: true, path: "Q1_ MediaDeck.pdf" });
    expect(normalizeLegacyPath("Newsroom/Downloads/A%26B.pdf")).toEqual({ ok: true, path: "Newsroom/Downloads/A&B.pdf" });
  });

  it("refuses traversal, dot segments, empty segments and Windows aliases", () => {
    for (const raw of [
      "../secret.pdf",
      "a/../../b.pdf",
      "%2e%2e/b.pdf",
      "a/%2E%2E/b.pdf",
      "./a.pdf",
      ".meta/x.json",
      "a/.hidden",
      "a//b.pdf",
      "a%2Fb.pdf",
      "a%5Cb.pdf",
      "a\\b.pdf",
      "c:x.pdf",
      "NEWS_F~1.PDF",
      "trailing.",
      "trailing%20",
      "nul%00.pdf",
      "%E0%A4%A",
      "a|b.pdf",
      "a%3Fb.pdf",
      "CON",
      "dir/aux.txt",
      "COM\u00b9",
      "com\u00b2.txt",
      "LPT\u00b3.pdf",
      "lpt\u00b9",
      "CONIN$",
      "conout$.log",
      "a/CONIN$.txt",
      "",
      "/",
    ]) {
      expect(normalizeLegacyPath(raw).ok, raw).toBe(false);
    }
  });

  it("refuses NRMS's own namespaces (releases/, slides/) in any case: Q17 keeps them NRMS's alone", () => {
    expect(normalizeLegacyPath("releases/x/translations/a.pdf")).toMatchObject({ ok: false, reason: expect.stringMatching(/reserved/) });
    expect(normalizeLegacyPath("Releases/a.pdf")).toMatchObject({ ok: false });
    expect(normalizeLegacyPath("SLIDES/a.png")).toMatchObject({ ok: false });
    // Only as the first segment.
    expect(normalizeLegacyPath("Newsroom/releases/a.pdf")).toEqual({ ok: true, path: "Newsroom/releases/a.pdf" });
  });
});

describe("legacyCandidates", () => {
  it("lowercase first, then as is, like legacy's Azure resolver; one candidate when already lowercase", () => {
    expect(legacyCandidates("Newsroom/A.pdf")).toEqual(["newsroom/a.pdf", "Newsroom/A.pdf"]);
    expect(legacyCandidates("a.pdf")).toEqual(["a.pdf"]);
  });
});

describe("extractFileReferences", () => {
  it("finds absolute news.gov.bc.ca links (http, https, www, protocol-relative, any case) and relative /files links", () => {
    const html = `
      <p><a href="https://news.gov.bc.ca/files/One.pdf">one</a>
      <a href='http://www.news.gov.bc.ca/files/Newsroom/Two.docx'>two</a>
      <a href="//NEWS.GOV.BC.CA/Files/three.pdf?download=1#page=2">three</a>
      <img src="/files/four.jpg" alt="">
      <a href="https://news.gov.bc.ca:443/files/five.pdf">five</a></p>`;
    expect(extractFileReferences(html).paths).toEqual(["One.pdf", "Newsroom/Two.docx", "three.pdf", "four.jpg", "five.pdf"]);
  });

  it("decodes percent-encoded names and HTML entities, and keeps spaces inside quoted attributes", () => {
    const html = `<a href="https://news.gov.bc.ca/files/Q1_%20MediaDeck.pdf">a</a> <a href="/files/A&amp;B.pdf">b</a> <a href="/files/Budget 2026 (final).pdf">c</a>`;
    expect(extractFileReferences(html).paths).toEqual(["Q1_ MediaDeck.pdf", "A&B.pdf", "Budget 2026 (final).pdf"]);
  });

  it("trims a stray no-break space (raw or &nbsp;) around an attribute value, as seen in live legacy bodies", () => {
    const html = '<a href="https://news.gov.bc.ca/files/BG_Bundle.pdf\u00a0">a</a> <a href="/files/Other.pdf&nbsp;">b</a> <a>https://news.gov.bc.ca/files/Text.pdf&nbsp;</a>';
    expect(extractFileReferences(html).paths).toEqual(["BG_Bundle.pdf", "Other.pdf", "Text.pdf"]);
  });

  it("finds links in plain text and log lines, trimming trailing punctuation", () => {
    const text = "See https://news.gov.bc.ca/files/Report.pdf, or (https://news.gov.bc.ca/files/Other.pdf). 2026-10-01 GET /files/Log%20Hit.pdf - 200";
    expect(extractFileReferences(text).paths).toEqual(["Report.pdf", "Other.pdf", "Log Hit.pdf"]);
  });

  it("ignores other hosts' /files/ and look-alike paths", () => {
    const html = `<a href="https://example.com/files/x.pdf">x</a> <a href="https://news.gov.bc.ca.evil.test/files/y.pdf">y</a> <a href="/assets/files/z.pdf">z</a> <a href="https://news.gov.bc.ca/filesx/w.pdf">w</a> https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net/files/v.pdf`;
    expect(extractFileReferences(html).paths).toEqual([]);
  });

  it("dedupes exact repeats (different case stays two references)", () => {
    const html = `<a href="/files/A.pdf"></a><a href="https://news.gov.bc.ca/files/A.pdf"></a><a href="/files/A%2Epdf"></a><a href="/files/a.pdf"></a>`;
    expect(extractFileReferences(html).paths).toEqual(["A.pdf", "a.pdf"]);
  });

  it("rejects traversal and reserved paths, with the reference and the reason", () => {
    const html = `<a href="/files/../../etc/passwd">x</a> <a href="https://news.gov.bc.ca/files/%2e%2e/secret">y</a> <a href="/files/releases/abc/x.pdf">z</a> <a href="/files/ok.pdf">ok</a>`;
    const r = extractFileReferences(html);
    expect(r.paths).toEqual(["ok.pdf"]);
    expect(r.rejected.map((x) => x.reference)).toEqual(["../../etc/passwd", "%2e%2e/secret", "releases/abc/x.pdf"]);
    for (const x of r.rejected) expect(x.reason).toBeTruthy();
  });

  it("a bare /files/ link names no file", () => {
    expect(extractFileReferences(`<a href="https://news.gov.bc.ca/files/">x</a> /files/ `).paths).toEqual([]);
  });
});

describe("parsePathsFile", () => {
  it("one path per line: bare, /files/-relative or absolute; comments and blanks skipped", () => {
    const r = parsePathsFile("# extra\n\nNews_Footage_License_British_Columbia.pdf\n/files/Newsroom/a%20b.pdf\nhttps://news.gov.bc.ca/files/c.pdf\n../x\n");
    expect(r.paths).toEqual(["News_Footage_License_British_Columbia.pdf", "Newsroom/a b.pdf", "c.pdf"]);
    expect(r.rejected).toHaveLength(1);
  });

  it("the footage licence is always known", () => {
    expect(KNOWN_LEGACY_FILES).toContain("News_Footage_License_British_Columbia.pdf");
  });
});
