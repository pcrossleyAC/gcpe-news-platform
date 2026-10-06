// Pure byte-level state machine for reading a hidden (unechoed) password from a TTY in raw
// mode. Kept in its own module -- separate from hash-password.ts, which has top-level
// side-effecting code (it reads real stdin as soon as it's imported/run) -- so this can be
// unit-tested without any stdin/TTY machinery.
//
// Raw bytes are accumulated undecoded and only turned into a string once, at submit time.
// Decoding byte-by-byte (e.g. with String.fromCharCode per byte) mangles any character
// outside ASCII, since a single UTF-8 code point can be split across several bytes (and
// across several `data` events). Backspace therefore has to remove one whole UTF-8 code
// point -- trailing continuation bytes (0b10xxxxxx) plus the one lead byte before them --
// not just the single last byte.

export interface KeypressState {
  readonly bytes: readonly number[];
}

export const INITIAL_KEYPRESS_STATE: KeypressState = { bytes: [] };

export type KeypressResult =
  | { readonly action: "continue"; readonly state: KeypressState }
  | { readonly action: "submit"; readonly value: string }
  | { readonly action: "cancel" };

const LF = 0x0a; // \n
const CR = 0x0d; // \r
const ETX = 0x03; // Ctrl-C
const EOT = 0x04; // Ctrl-D
const DEL = 0x7f;
const BS = 0x08;

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Removes the last complete UTF-8 code point: its trailing continuation bytes, then its lead byte. */
function stripLastCodePoint(bytes: readonly number[]): number[] {
  const result = bytes.slice();
  while (result.length > 0 && isUtf8ContinuationByte(result[result.length - 1]!)) result.pop();
  if (result.length > 0) result.pop();
  return result;
}

/**
 * Processes one chunk of raw stdin bytes against the accumulated (still-undecoded) state.
 * Enter submits (decoding the accumulated bytes as UTF-8 exactly once); Ctrl-C/Ctrl-D cancel;
 * Backspace/Delete remove one whole code point; everything else is appended as a raw byte.
 */
export function applyKeypress(state: KeypressState, chunk: Uint8Array): KeypressResult {
  let bytes = state.bytes;
  for (const byte of chunk) {
    if (byte === LF || byte === CR) return { action: "submit", value: Buffer.from(bytes).toString("utf8") };
    if (byte === ETX || byte === EOT) return { action: "cancel" };
    if (byte === DEL || byte === BS) {
      bytes = stripLastCodePoint(bytes);
      continue;
    }
    bytes = [...bytes, byte];
  }
  return { action: "continue", state: { bytes } };
}
