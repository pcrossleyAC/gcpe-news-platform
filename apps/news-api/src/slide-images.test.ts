import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slideImageFetcher, SlideImageError } from "./slide-images";

const FETCH_BASE = "http://stack.internal/files";
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
const sha = createHash("sha256").update(png).digest("hex");
// imageUrl deliberately points at a different, attacker-controlled-looking host: the fetcher
// must never dial it — only fetchBase + imageKey.
const ref = { imageUrl: "https://evil.example/not-the-real-file.png", imageKey: `slides/${sha}.png`, imageSha256: sha };

describe("slideImageFetcher", () => {
  it("joins fetchBase and imageKey, and never fetches the event's own imageUrl", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => new Response(png));
    const bytes = await slideImageFetcher({ fetchBase: `${FETCH_BASE}/`, fetchImpl: f as unknown as typeof fetch }).fetch(ref);
    expect(bytes.equals(png)).toBe(true);
    expect(f.mock.calls[0]![0].toString()).toBe(`${FETCH_BASE}/slides/${sha}.png`);
    expect(f.mock.calls[0]![0].toString()).not.toBe(ref.imageUrl);
  });

  it("passes redirect: \"error\" on every fetch, so a redirect from fetchBase is never silently followed", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(png));
    await slideImageFetcher({ fetchBase: FETCH_BASE, fetchImpl: f as unknown as typeof fetch }).fetch(ref);
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    ["a different hash", async () => new Response(Buffer.from("other"))],
    ["a 404", async () => new Response("nope", { status: 404 })],
    ["a 3xx redirect", async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
    ["a body over 2 MB", async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1))],
    ["a declared length over 2 MB", async () => new Response(png, { headers: { "content-length": String(3 * 1024 * 1024) } })],
  ])("refuses %s", async (_name, impl) => {
    await expect(slideImageFetcher({ fetchBase: FETCH_BASE, fetchImpl: impl as unknown as typeof fetch }).fetch(ref)).rejects.toBeInstanceOf(SlideImageError);
  });

  it("refuses an imageKey outside slides/ before fetching", async () => {
    const f = vi.fn();
    await expect(
      slideImageFetcher({ fetchBase: FETCH_BASE, fetchImpl: f as unknown as typeof fetch }).fetch({ ...ref, imageKey: "../etc/passwd" }),
    ).rejects.toBeInstanceOf(SlideImageError);
    expect(f).not.toHaveBeenCalled();
  });

  it("aborts once the streamed byte count passes the limit, even when content-length under-declares it", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MB
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 3 MB total, over the 2 MB limit
        controller.close();
      },
    });
    // Lies: declares only 1 MB, so the early content-length check alone would miss this —
    // only the streaming byte count catches it.
    const f = vi.fn(async () => new Response(stream, { headers: { "content-length": String(1024 * 1024) } }));
    await expect(slideImageFetcher({ fetchBase: FETCH_BASE, fetchImpl: f as unknown as typeof fetch }).fetch(ref)).rejects.toBeInstanceOf(SlideImageError);
  });

  it("accepts a body assembled from several chunks that stays within the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 50));
        controller.enqueue(png.subarray(50));
        controller.close();
      },
    });
    const f = vi.fn(async () => new Response(stream));
    const bytes = await slideImageFetcher({ fetchBase: FETCH_BASE, fetchImpl: f as unknown as typeof fetch }).fetch(ref);
    expect(bytes.equals(png)).toBe(true);
  });

  describe("against a real server (redirect: \"error\" actually closes the gap)", () => {
    let server: Server | undefined;
    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    it("refuses when the configured fetch base itself redirects elsewhere, instead of following it", async () => {
      server = createServer((_req, res) => {
        res.writeHead(302, { Location: "http://127.0.0.1:1/unreachable-sentinel" });
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server!.address() as AddressInfo;
      await expect(slideImageFetcher({ fetchBase: `http://127.0.0.1:${port}/files` }).fetch(ref)).rejects.toBeInstanceOf(SlideImageError);
    });

    it("fetches real bytes from the configured fetch base when there's no redirect", async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server!.address() as AddressInfo;
      const bytes = await slideImageFetcher({ fetchBase: `http://127.0.0.1:${port}/files` }).fetch(ref);
      expect(bytes.equals(png)).toBe(true);
    });
  });
});
