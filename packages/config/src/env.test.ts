import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  const schema = z.object({ PORT: z.coerce.number().int().default(3000), DATABASE_URL: z.string().url() });

  it("parses and coerces values", () => {
    expect(parseEnv(schema, { DATABASE_URL: "postgres://x/y", PORT: "8080" })).toEqual({
      DATABASE_URL: "postgres://x/y",
      PORT: 8080,
    });
  });

  it("names every invalid variable in the error", () => {
    expect(() => parseEnv(schema, { PORT: "abc" })).toThrow(/PORT.*DATABASE_URL|DATABASE_URL.*PORT/);
  });
});
