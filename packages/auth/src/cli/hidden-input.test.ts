import { describe, expect, it } from "vitest";
import { applyKeypress, INITIAL_KEYPRESS_STATE, type KeypressState } from "./hidden-input";

/** Feeds a sequence of one-byte chunks through applyKeypress, as if each byte arrived in its own `data` event. */
function typeBytes(bytes: Iterable<number>): { result: ReturnType<typeof applyKeypress>; state: KeypressState } {
  let state: KeypressState = INITIAL_KEYPRESS_STATE;
  let result: ReturnType<typeof applyKeypress> = { action: "continue", state };
  for (const byte of bytes) {
    result = applyKeypress(state, Uint8Array.of(byte));
    if (result.action !== "continue") return { result, state };
    state = result.state;
  }
  return { result, state };
}

describe("applyKeypress (hidden TTY password input)", () => {
  it('decodes "pässwörd" typed as UTF-8 bytes, one byte per data event, to the exact string', () => {
    const bytes = Buffer.from("pässwörd", "utf8");
    const { result } = typeBytes([...bytes, 0x0a]); // Enter
    expect(result).toEqual({ action: "submit", value: "pässwörd" });
  });

  it("decodes correctly even when a multi-byte character arrives in multiple chunks at once", () => {
    // "ö" is 0xC3 0xB6 in UTF-8 -- split the lead byte and continuation byte across two chunks.
    const oUmlaut = Buffer.from("ö", "utf8");
    let state: KeypressState = INITIAL_KEYPRESS_STATE;
    let step = applyKeypress(state, Uint8Array.of(oUmlaut[0]!));
    if (step.action !== "continue") throw new Error("unexpected early exit");
    state = step.state;
    step = applyKeypress(state, Uint8Array.of(oUmlaut[1]!, 0x0a));
    expect(step).toEqual({ action: "submit", value: "ö" });
  });

  it("backspace over a multibyte character removes the whole character, not one byte", () => {
    // "a" followed by "ä" (0xC3 0xA4), then Backspace, then Enter -- must submit "a", not "a" + a stray continuation byte.
    const bytes = [...Buffer.from("a", "utf8"), ...Buffer.from("ä", "utf8"), 0x7f, 0x0a];
    const { result } = typeBytes(bytes);
    expect(result).toEqual({ action: "submit", value: "a" });
  });

  it("backspace (DEL) and Backspace (BS) both remove exactly one ASCII character", () => {
    expect(typeBytes([...Buffer.from("ab", "utf8"), 0x7f, 0x0a]).result).toEqual({ action: "submit", value: "a" });
    expect(typeBytes([...Buffer.from("ab", "utf8"), 0x08, 0x0a]).result).toEqual({ action: "submit", value: "a" });
  });

  it("backspace on empty input is a no-op, not an error", () => {
    const { result } = typeBytes([0x7f, 0x7f, ...Buffer.from("x", "utf8"), 0x0a]);
    expect(result).toEqual({ action: "submit", value: "x" });
  });

  it("Ctrl-C cancels immediately, discarding whatever was typed so far", () => {
    const { result } = typeBytes([...Buffer.from("partial", "utf8"), 0x03]);
    expect(result).toEqual({ action: "cancel" });
  });

  it("Ctrl-D also cancels (so raw mode is always restored, never left hanging)", () => {
    const { result } = typeBytes([...Buffer.from("partial", "utf8"), 0x04]);
    expect(result).toEqual({ action: "cancel" });
  });

  it("both \\n and \\r submit", () => {
    expect(typeBytes([...Buffer.from("x", "utf8"), 0x0a]).result).toEqual({ action: "submit", value: "x" });
    expect(typeBytes([...Buffer.from("x", "utf8"), 0x0d]).result).toEqual({ action: "submit", value: "x" });
  });
});
