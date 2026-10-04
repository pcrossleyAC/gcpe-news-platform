import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeFlickr } from "@gcpe/flickr-fake";
import { authorizeFlow } from "./flickr-authorize-flow";

describe("authorizeFlow against the fake Flickr", () => {
  const creds = { apiKey: "fake-key", apiSecret: "fake-secret", accessToken: "fake-access-token", accessSecret: "fake-access-secret" };
  let server: Server;
  let oauthUrl: string;

  beforeAll(async () => {
    const app = express();
    // Bind first so the fake's public base can be the very URL the flow signs.
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-flickr`;
    const fake = createFakeFlickr({ ...creds, publicBaseUrl: base });
    app.use("/fake-flickr", fake.router);
    oauthUrl = `${base}/services/oauth`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("signs in with the verifier the fake's authorize page shows and returns its access token, secret and username", async () => {
    const printed: string[] = [];
    const result = await authorizeFlow({
      oauthUrl,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      prompt: async () => "123-456-789",
      print: (line) => printed.push(line),
    });
    expect(result).toEqual({ accessToken: creds.accessToken, accessSecret: creds.accessSecret, username: "bcgovphotos" });
  });

  it("prints the authorize URL with perms=write before prompting", async () => {
    const printed: string[] = [];
    let promptedAfterPrint = false;
    await authorizeFlow({
      oauthUrl,
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      print: (line) => printed.push(line),
      prompt: async () => {
        promptedAfterPrint = printed.length > 0;
        return "123-456-789";
      },
    });
    expect(promptedAfterPrint).toBe(true);
    expect(printed.some((l) => l.includes("Open this address"))).toBe(true);
    const urlLine = printed.find((l) => l.includes("/authorize?oauth_token="));
    expect(urlLine).toBeDefined();
    expect(urlLine).toContain("perms=write");
  });

  it("a wrong consumer secret throws mentioning the HTTP status, never the response body", async () => {
    await expect(
      authorizeFlow({
        oauthUrl,
        apiKey: creds.apiKey,
        apiSecret: "wrong-secret",
        prompt: async () => "123-456-789",
        print: () => {},
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("a wrong verification code at the access_token step also throws mentioning the HTTP status", async () => {
    await expect(
      authorizeFlow({
        oauthUrl,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        prompt: async () => "not-the-verifier",
        print: () => {},
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
