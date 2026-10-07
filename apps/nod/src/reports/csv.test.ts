import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, csvFilename, csvLine, oneBatch, streamCsv, type CsvCell } from "./csv";

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** False when the connection ended before the response did (a destroyed stream). */
  complete: boolean;
}

/** Serves one handler on a real socket, so a destroyed response is observable as an incomplete one. */
function serve(handler: express.RequestHandler): Promise<Raw> {
  const app = express();
  app.get("/x", handler);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const req = http.get({ port, path: "/x" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () => undefined);
        res.on("close", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete });
        });
      });
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
    });
  });
}

describe("csvCell", () => {
  it("neutralises cells a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe(`"'\rcmd"`);
  });

  it("quotes commas, quotes, line breaks and edge spaces; leaves plain text and numbers alone", () => {
    expect(csvCell("Health, Ministry of")).toBe(`"Health, Ministry of"`);
    expect(csvCell('Say "hi"')).toBe(`"Say ""hi"""`);
    expect(csvCell("two\nlines")).toBe(`"two\nlines"`);
    expect(csvCell(" padded ")).toBe(`" padded "`);
    expect(csvCell("pat@example.test")).toBe("pat@example.test");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("neutralises a formula lead hidden behind whitespace, a stray BOM, or a full-width operator", () => {
    expect(csvCell(" =1+1")).toBe("' =1+1");
    expect(csvCell("\n=1+1")).toBe(`"'\n=1+1"`);
    expect(csvCell(" =1+1")).toBe("' =1+1");
    expect(csvCell("﻿=1+1")).toBe("'﻿=1+1");
    expect(csvCell("＝1+1")).toBe("'＝1+1");
    expect(csvCell(" ＋1")).toBe("' ＋1");
    expect(csvCell("－1")).toBe("'－1");
    expect(csvCell("＠SUM(A1)")).toBe("'＠SUM(A1)");
  });

  it("joins a line with CRLF", () => {
    expect(csvLine(["a", 1, null])).toBe("a,1,\r\n");
  });

  it("names files <report>-<date>.csv and refuses anything else", () => {
    expect(csvFilename("release-sends", "2026-10-07")).toBe("release-sends-2026-10-07.csv");
    expect(() => csvFilename('x"; evil', "2026-10-07")).toThrow();
  });
});

describe("streamCsv", () => {
  it("streams a UTF-8 BOM, the header and CRLF rows as an attachment", async () => {
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "test-2026-10-07.csv", ["Email", "Count"], oneBatch([["pat@example.test", 2], ["=1+1", 3]]));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="test-2026-10-07.csv"');
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect([...r.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.body.toString("utf8")).toBe(`${CSV_BOM}Email,Count\r\npat@example.test,2\r\n'=1+1,3\r\n`);
    expect(r.complete).toBe(true);
  });

  it("writes every row of many batches, in order", async () => {
    async function* batches(): AsyncGenerator<CsvCell[][]> {
      for (let b = 0; b < 10; b++) yield Array.from({ length: 1000 }, (_, i) => [`row-${b * 1000 + i}`]);
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "many-2026-10-07.csv", ["Row"], batches());
    });
    const lines = r.body.toString("utf8").split("\r\n");
    expect(lines).toHaveLength(10_002); // header + 10,000 rows + the empty string after the last CRLF
    expect(lines[1]).toBe("row-0");
    expect(lines[10_000]).toBe("row-9999");
  });

  it("a failure part-way aborts the download instead of ending it cleanly", async () => {
    async function* failing(): AsyncGenerator<CsvCell[][]> {
      yield [["first@example.test"]];
      await new Promise((r) => setTimeout(r, 50)); // let the header reach the client first
      throw new Error("boom");
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], failing()).catch(() => undefined);
    });
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
  });

  it("a failure before the first byte is a JSON error, with no CSV headers", async () => {
    async function* failsAtOnce(): AsyncGenerator<CsvCell[][]> {
      throw new Error("boom");
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], failsAtOnce()).catch(() => void res.status(500).json({ error: "internal error" }));
    });
    expect(r.status).toBe(500);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(r.headers["content-disposition"]).toBeUndefined();
  });

  it("runs onStart only once the first batch is in hand, so a pre-stream failure never runs it", async () => {
    let started = 0;
    const onStart = async () => {
      started++;
    };

    async function* failsAtOnce(): AsyncGenerator<CsvCell[][]> {
      throw new Error("boom");
    }
    const failed = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], failsAtOnce(), onStart).catch(() => void res.status(500).json({ error: "internal error" }));
    });
    expect(failed.status).toBe(500);
    expect(started).toBe(0);

    const ok = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], oneBatch([["pat@example.test"]]), onStart);
    });
    expect(ok.status).toBe(200);
    expect(started).toBe(1);
  });

  it("stops pulling batches and closes the generator soon after the client disconnects", async () => {
    let fetched = 0;
    let closed = false;

    async function* manyOneRowBatches(): AsyncGenerator<CsvCell[][]> {
      try {
        for (let i = 0; i < 500; i++) {
          fetched++;
          yield [[`row-${i}`]];
          await new Promise((r) => setTimeout(r, 2)); // give the client's abort time to reach the server
        }
      } finally {
        closed = true;
      }
    }

    const app = express();
    app.get("/x", async (_req, res) => {
      await streamCsv(res, "many-2026-10-07.csv", ["Row"], manyOneRowBatches()).catch(() => undefined);
    });
    await new Promise<void>((resolve) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.get({ port, path: "/x" }, (res) => {
          res.once("data", () => req.destroy()); // the client gives up right after the first chunk
        });
        req.on("error", () => undefined);
        req.on("close", () => {
          // The server notices the disconnect (and runs the generator's own cleanup) a moment
          // after the client's own socket close fires; give that a moment before asserting.
          setTimeout(() => {
            server.close();
            resolve();
          }, 100);
        });
      });
    });

    expect(closed).toBe(true);
    expect(fetched).toBeLessThan(100); // nowhere near the full 500 -- the generator was closed, not drained
  });
});
