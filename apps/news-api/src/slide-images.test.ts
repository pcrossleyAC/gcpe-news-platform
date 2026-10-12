import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { slideImageFetcher, SlideImageError } from "./slide-images";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
const sha = createHash("sha256").update(png).digest("hex");
const ref = { imageUrl: `https://files.example/files/slides/${sha}.png`, imageKey: `slides/${sha}.png`, imageSha256: sha };

describe("slideImageFetcher", () => {
  it("fetches imageUrl and returns the bytes when the hash matches", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => new Response(png));
    expect((await slideImageFetcher({ fetchImpl: f as unknown as typeof fetch }).fetch(ref)).equals(png)).toBe(true);
    expect(f.mock.calls[0]![0].toString()).toBe(ref.imageUrl);
  });

  it("joins fetchBase and imageKey when a fetch base is set", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => new Response(png));
    await slideImageFetcher({ fetchBase: "http://stack.internal/files/", fetchImpl: f as unknown as typeof fetch }).fetch(ref);
    expect(f.mock.calls[0]![0].toString()).toBe(`http://stack.internal/files/slides/${sha}.png`);
  });

  it.each([
    ["a different hash", async () => new Response(Buffer.from("other"))],
    ["a 404", async () => new Response("nope", { status: 404 })],
    ["a body over 2 MB", async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1))],
    ["a declared length over 2 MB", async () => new Response(png, { headers: { "content-length": String(3 * 1024 * 1024) } })],
  ])("refuses %s", async (_name, impl) => {
    await expect(slideImageFetcher({ fetchImpl: impl as unknown as typeof fetch }).fetch(ref)).rejects.toBeInstanceOf(SlideImageError);
  });

  it("refuses an imageKey outside slides/ before fetching", async () => {
    const f = vi.fn();
    await expect(
      slideImageFetcher({ fetchBase: "http://x/files", fetchImpl: f as unknown as typeof fetch }).fetch({ ...ref, imageKey: "../etc/passwd" }),
    ).rejects.toBeInstanceOf(SlideImageError);
    expect(f).not.toHaveBeenCalled();
  });
});
