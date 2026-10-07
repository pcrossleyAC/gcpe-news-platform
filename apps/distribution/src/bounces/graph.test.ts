import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

/**
 * A fetchImpl that asserts each call happens in the given order and matches the expected
 * method/URL pattern before answering with its recorded response — so a test failure points at
 * exactly which call went wrong, not just a generic assertion mismatch deep inside graph.ts.
 */
function recordedFetch(steps: Step[]): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[i];
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!step) throw new Error(`unexpected extra fetch call: ${method} ${url}`);
    i++;
    if (step.method && step.method !== method) throw new Error(`call ${i}: expected method ${step.method}, got ${method} (${url})`);
    if (!step.match.test(url)) throw new Error(`call ${i}: URL did not match ${step.match}: ${url}`);
    return step.response();
  }) as unknown as typeof fetch;
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
