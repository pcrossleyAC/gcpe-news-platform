import { describe, expect, it, vi } from "vitest";
import { distributionClient, nodClient } from "./clients";

describe("nodClient", () => {
  it("counts subscribers via a signed GET, encoding the list keys and the bearer token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ count: 42 }), { status: 200 }));
    const client = nodClient({ baseUrl: "https://nod.example", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    const count = await client.countSubscribers(["ministries:health", "sectors:health"]);

    expect(count).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://nod.example/api/subscribers/count?lists=ministries%3Ahealth%2Csectors%3Ahealth");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("rejects with the status on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = nodClient({ baseUrl: "https://nod.example", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.countSubscribers([])).rejects.toThrow(/NoD count failed: HTTP 500/);
  });
});

describe("distributionClient", () => {
  const msg = {
    priority: "system" as const,
    subject: "DRAFT - Weekend clinics open across B.C.",
    html: "<p>hi</p>",
    text: "hi",
    recipients: [{ email: "editor@example.test" }],
    attachments: [{ filename: "DRAFT-x.txt", contentType: "text/plain" as const, contentBase64: Buffer.from("hi").toString("base64") }],
  };

  it("posts the message as JSON to /api/messages with bearer auth and returns the batch id", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ batchId: "b-1" }), { status: 202 }));
    const client = distributionClient({ baseUrl: "https://dist.example/", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.send(msg)).resolves.toEqual({ batchId: "b-1" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://dist.example/api/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(msg);
  });

  it("rejects with the status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 }));
    const client = distributionClient({ baseUrl: "https://dist.example", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.send(msg)).rejects.toThrow(/HTTP 400/);
  });
});
