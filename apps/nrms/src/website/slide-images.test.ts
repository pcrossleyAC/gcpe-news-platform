import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb } from "../../test/helpers";
import { carousels, emergencyPins, websiteSlides } from "../db/schema";
import { ensureSlideImageFiles, publishSlideImage, slideImageRef, type SlideImageFiles } from "./slide-images";

const ONE_PX_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);

describe("slide-images", () => {
  let root: string;
  let store: ObjectStore;
  let files: SlideImageFiles;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nrms-slide-images-"));
    store = localStore(root, "/files/");
    files = { store, filesBase: "" };
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("slideImageRef: a content-addressed key, the public URL and the hash", () => {
    const bytes = Buffer.from("png-bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(slideImageRef({ store, filesBase: "https://boxs.example" }, bytes, "image/png")).toEqual({
      imageKey: `slides/${sha}.png`,
      imageUrl: `https://boxs.example/files/slides/${sha}.png`,
      imageSha256: sha,
    });
    expect(slideImageRef({ store, filesBase: "" }, bytes, "image/jpeg").imageUrl).toBe(`/files/slides/${sha}.jpg`);
  });

  it("refuses a type that isn't PNG or JPEG", () => {
    expect(() => slideImageRef({ store, filesBase: "" }, Buffer.from("x"), "image/gif")).toThrow();
  });

  it("publishSlideImage writes the bytes once under that key", async () => {
    await publishSlideImage(files, ONE_PX_PNG, "image/png");
    const { imageKey } = slideImageRef(files, ONE_PX_PNG, "image/png");
    expect((await store.get(imageKey))!.bytes.equals(ONE_PX_PNG)).toBe(true);
  });

  describe("ensureSlideImageFiles", () => {
    let tdb: TestDatabase;

    beforeAll(async () => {
      tdb = await createNrmsTestDb();
    });
    afterAll(async () => {
      await tdb.drop();
    });
    afterEach(async () => {
      await tdb.pool.query("TRUNCATE carousels, slides, emergency_pins CASCADE");
      await tdb.pool.query("INSERT INTO emergency_pins (slot) VALUES ('primary'), ('secondary')");
    });

    it("writes a file for every stored slide and pin image that lacks one, and nothing twice", async () => {
      const [carousel] = await tdb.db.insert(carousels).values({ state: "past" }).returning();
      const slideImageBytes = Buffer.concat([ONE_PX_PNG, Buffer.from("slide")]);
      const pinImageBytes = Buffer.concat([ONE_PX_PNG, Buffer.from("pin")]);
      await tdb.db.insert(websiteSlides).values([
        { carouselId: carousel!.id, sortIndex: 0, headline: "Imaged", image: slideImageBytes, imageType: "image/png" },
        { carouselId: carousel!.id, sortIndex: 1, headline: "No image" },
      ]);
      await tdb.db.update(emergencyPins).set({ image: pinImageBytes, imageType: "image/png" }).where(eq(emergencyPins.slot, "primary"));

      expect(await ensureSlideImageFiles(tdb.db, files)).toBe(2);
      expect(await ensureSlideImageFiles(tdb.db, files)).toBe(0);

      const slideRef = slideImageRef(files, slideImageBytes, "image/png");
      const pinRef = slideImageRef(files, pinImageBytes, "image/png");
      expect((await store.get(slideRef.imageKey))!.bytes.equals(slideImageBytes)).toBe(true);
      expect((await store.get(pinRef.imageKey))!.bytes.equals(pinImageBytes)).toBe(true);
    });
  });
});
