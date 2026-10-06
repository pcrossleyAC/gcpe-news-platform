import { describe, expect, it } from "vitest";
import { eventSecretsSchema } from "./event-secrets";

describe("eventSecretsSchema", () => {
  it("defaults to an empty object", () => {
    expect(eventSecretsSchema.parse(undefined)).toEqual({});
  });

  it("parses a valid JSON object of strings", () => {
    expect(eventSecretsSchema.parse('{"core":"dev","nrms":"dev"}')).toEqual({ core: "dev", nrms: "dev" });
  });

  it("raises a zod issue for invalid JSON", () => {
    const result = eventSecretsSchema.safeParse("{not json");
    expect(result.success).toBe(false);
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe("must be valid JSON");
  });

  it("raises a zod issue for a non-string value", () => {
    const arrayResult = eventSecretsSchema.safeParse("[1,2,3]");
    expect(arrayResult.success).toBe(false);
    expect(arrayResult.success ? undefined : arrayResult.error.issues[0]?.message).toBe("must be a JSON object of string values");

    const numberValueResult = eventSecretsSchema.safeParse('{"core":1}');
    expect(numberValueResult.success).toBe(false);
    expect(numberValueResult.success ? undefined : numberValueResult.error.issues[0]?.message).toBe("must be a JSON object of string values");
  });
});
