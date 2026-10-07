import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { graphBounceSource, GraphBounceSourceError } from "./graph";

const fixturesDir = fileURLToPath(new URL("../../test/fixtures/graph/", import.meta.url));
const fixture = (name: string): string => readFileSync(`${fixturesDir}${name}`, "utf8");

const TOKEN_JSON = fixture("token.json");
const BOUNCE_EML = fixture("bounce.eml");

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "message/rfc822" } });
}

type Step = { method?: string; match: RegExp; response: () => Response };
/** A fetchImpl with how many of its recorded steps were actually consumed, so a test can
 * assert every expected call happened (not just that the ones that did happen were in order —
 * `recordedFetch` alone only catches an out-of-order/extra call, not an early stop that simply
 * never reaches the later steps). */
type RecordedFetch = typeof fetch & { callCount: () => number };

/**
 * A fetchImpl that asserts each call happens in the given order and matches the expected
 * method/URL pattern before answering with its recorded response — so a test failure points at
 * exactly which call went wrong, not just a generic assertion mismatch deep inside graph.ts.
 */
function recordedFetch(steps: Step[]): RecordedFetch {
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[i];
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!step) throw new Error(`unexpected extra fetch call: ${method} ${url}`);
    i++;
    if (step.method && step.method !== method) throw new Error(`call ${i}: expected method ${step.method}, got ${method} (${url})`);
    if (!step.match.test(url)) throw new Error(`call ${i}: URL did not match ${step.match}: ${url}`);
    return step.response();
  }) as RecordedFetch;
  impl.callCount = () => i;
  return impl;
}

const baseOpts = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1", mailbox: "bounces@example.test" };

describe("graphBounceSource", () => {
  it("fetchNew lists unread messages, selecting only id, then downloads each MIME body", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      {
        match: /\/users\/bounces%40example\.test\/mailFolders\/inbox\/messages\?.*isRead/,
        response: () => jsonResponse(fixture("list-one-unread.json")),
      },
      { match: /\/users\/bounces%40example\.test\/messages\/AAMkAGI-graph-message-1\/\$value/, response: () => textResponse(BOUNCE_EML) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    const fetched = await source.fetchNew(50);

    expect(fetched).toEqual([{ id: "AAMkAGI-graph-message-1", raw: BOUNCE_EML }]);
  });

  it("fetchNew lists unread messages oldest-received first", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\/inbox\/messages\?.*\$orderby=receivedDateTime(%20| )asc/, response: () => jsonResponse(fixture("list-one-unread.json")) },
      { match: /\/messages\/AAMkAGI-graph-message-1\/\$value/, response: () => textResponse(BOUNCE_EML) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    await expect(source.fetchNew(50)).resolves.toEqual([{ id: "AAMkAGI-graph-message-1", raw: BOUNCE_EML }]);
  });

  it("fetchNew skips a message whose $value download fails, logging only a safe label and its id, and still returns the rest", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\/inbox\/messages/, response: () => jsonResponse(fixture("list-two-unread.json")) },
      { match: /\/messages\/AAMkAGI-graph-poison\/\$value/, response: () => jsonResponse('{"error":{"code":"ErrorItemNotFound","message":"secret diagnostic text"}}', 404) },
      { match: /\/messages\/AAMkAGI-graph-ok\/\$value/, response: () => textResponse(BOUNCE_EML) },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    const fetched = await source.fetchNew(50);

    expect(fetched).toEqual([{ id: "AAMkAGI-graph-ok", raw: BOUNCE_EML }]);
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("AAMkAGI-graph-poison");
    expect(logged).not.toContain("secret diagnostic text");
    errorSpy.mockRestore();
  });

  it("markProcessed marks each message read and moves it, creating the Processed folder when it doesn't exist yet", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\?.*displayName/, response: () => jsonResponse(fixture("folder-missing.json")) },
      { method: "POST", match: /\/mailFolders$/, response: () => jsonResponse(fixture("folder-created.json")) },
      { method: "PATCH", match: /\/messages\/AAMkAGI-graph-message-1$/, response: () => jsonResponse(fixture("mark-read.json")) },
      { method: "POST", match: /\/messages\/AAMkAGI-graph-message-1\/move$/, response: () => jsonResponse(fixture("move.json")) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    await expect(source.markProcessed(["AAMkAGI-graph-message-1"])).resolves.toBeUndefined();
  });

  it("markProcessed reuses an existing Processed folder instead of creating one", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\?.*displayName/, response: () => jsonResponse(fixture("folder-found.json")) },
      { method: "PATCH", match: /\/messages\/AAMkAGI-graph-message-1$/, response: () => jsonResponse(fixture("mark-read.json")) },
      { method: "POST", match: /\/messages\/AAMkAGI-graph-message-1\/move$/, response: () => jsonResponse(fixture("move.json")) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    await expect(source.markProcessed(["AAMkAGI-graph-message-1"])).resolves.toBeUndefined();
  });

  it("markProcessed isolates per-id failures: a failing move for one id doesn't stop the others from being marked and moved", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\?.*displayName/, response: () => jsonResponse(fixture("folder-found.json")) },
      // id-1: mark-read and move both succeed.
      { method: "PATCH", match: /\/messages\/id-1$/, response: () => jsonResponse(fixture("mark-read.json")) },
      { method: "POST", match: /\/messages\/id-1\/move$/, response: () => jsonResponse(fixture("move.json")) },
      // id-2: mark-read succeeds, the move fails -- must not stop id-3 below from being tried.
      { method: "PATCH", match: /\/messages\/id-2$/, response: () => jsonResponse(fixture("mark-read.json")) },
      { method: "POST", match: /\/messages\/id-2\/move$/, response: () => jsonResponse('{"error":{"code":"ErrorItemNotFound"}}', 500) },
      // id-3: mark-read and move both succeed, despite id-2's failure just above.
      { method: "PATCH", match: /\/messages\/id-3$/, response: () => jsonResponse(fixture("mark-read.json")) },
      { method: "POST", match: /\/messages\/id-3\/move$/, response: () => jsonResponse(fixture("move.json")) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    const error = await source.markProcessed(["id-1", "id-2", "id-3"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphBounceSourceError);
    expect((error as Error).message).not.toContain("id-2");
    // The decisive check: every one of the 8 recorded steps was reached, including id-3's
    // mark-read and move *after* id-2's move failed -- an implementation that aborts on the
    // first failure would stop at step 6 (id-2's failed move) and never get here.
    expect(fetchImpl.callCount()).toBe(8);
  });

  it("markProcessed with an empty array makes no request at all", async () => {
    const fetchImpl = recordedFetch([]);
    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    await expect(source.markProcessed([])).resolves.toBeUndefined();
  });

  it("a 401 throws a typed GraphBounceSourceError whose message carries no token", async () => {
    const fetchImpl = recordedFetch([
      { method: "POST", match: /oauth2\/v2\.0\/token/, response: () => jsonResponse(TOKEN_JSON) },
      { match: /\/mailFolders\/inbox\/messages/, response: () => jsonResponse(fixture("unauthorized.json"), 401) },
    ]);

    const source = graphBounceSource({ ...baseOpts, fetchImpl });
    const error = await source.fetchNew(50).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphBounceSourceError);
    const message = (error as Error).message;
    expect(message).not.toContain("synthetic-test-access-token");
    expect(message).not.toContain("Bearer");
    expect(message).toContain("401");
  });
});
