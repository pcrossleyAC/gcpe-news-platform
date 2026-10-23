import { FAKE_PHONE, fakeEmailFor, fakePhone } from "./identity";
import { normToken, TOKEN_RE, type PeopleIndex, type VariantHit } from "./people";

export const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** North American numbers with an area code: 604-555-0142, (604) 555-0142, 604.555.0142, +1 604 555 0142, 1-800-…, with ext./x. */
const FULL_PHONE_RE = /(?<![\w+\-–])(?:\+?1[ .\-–]?)?(?:\(\d{3}\)[ .\-–]?|\d{3}[ .\-–])\d{3}[ .\-–]\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?(?![\w\-–])/gi;
/**
 * Seven-digit local numbers, only with a hyphen or dot, so years, ids and keys aren't mistaken for them.
 * A following period is a sentence end unless a digit comes after it.
 */
const LOCAL_PHONE_RE = /(?<![\w+.-])\d{3}[.-]\d{4}(?![\w-]|\.\d)/g;
const TEST_DOMAIN = "@example.test";

export interface Counts { names: number; emails: number; phones: number }
export interface ScrubCtx { index: PeopleIndex; key: string }

export function phoneSpans(text: string): { start: number; end: number; local: boolean }[] {
  const spans: { start: number; end: number; local: boolean }[] = [];
  for (const m of text.matchAll(FULL_PHONE_RE)) spans.push({ start: m.index, end: m.index + m[0].length, local: false });
  for (const m of text.matchAll(LOCAL_PHONE_RE)) {
    const start = m.index, end = m.index + m[0].length;
    if (!spans.some((x) => start < x.end && end > x.start)) spans.push({ start, end, local: true });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** What may sit between two parts of one name: spaces, line breaks, non-breaking spaces and tags. */
const JOIN_GAP = /^(?:\s|&nbsp;|&#160;|&#xa0;|<[^<>]{0,200}>)+$/i;
const COMMA_GAP = /^(?:\s|&nbsp;|&#160;|&#xa0;)*,(?:\s|&nbsp;|&#160;|&#xa0;)*$/i;
const POSSESSIVE = /['’]s$/i;

const TAG_RE = /<[^<>]{0,200}>/g;
const ENTITY_RE = /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/gi;
/** Tags and entities: tags are blanked out of running text, entities are read as the character they stand for. */
const MARKUP_RE = /<[^<>]{0,200}>|&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/gi;

/** Accent names used in entities like &eacute; &Ntilde; &ccaron;: the letter plus the combining accent. */
const ACCENT_MARKS: Record<string, string> = {
  grave: "\u0300", acute: "\u0301", circ: "\u0302", tilde: "\u0303", macr: "\u0304", breve: "\u0306", dot: "\u0307",
  uml: "\u0308", ring: "\u030a", dblac: "\u030b", caron: "\u030c", cedil: "\u0327", ogon: "\u0328",
};
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: "\u00a0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", shy: "",
  AElig: "Æ", aelig: "æ", szlig: "ß", ETH: "Ð", eth: "ð", THORN: "Þ", thorn: "þ", Oslash: "Ø", oslash: "ø", OElig: "Œ", oelig: "œ",
  Lstrok: "Ł", lstrok: "ł", Dstrok: "Đ", dstrok: "đ", Hstrok: "Ħ", hstrok: "ħ", Tstrok: "Ŧ", tstrok: "ŧ", ENG: "Ŋ", eng: "ŋ",
  imath: "ı", inodot: "ı", IJlig: "Ĳ", ijlig: "ĳ", Lmidot: "Ŀ", lmidot: "ŀ",
};
/** Old editors wrote Windows-1252 code points as numeric entities, and browsers still show them that way. */
const CP1252: Record<number, string> = { 0x8a: "Š", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x96: "–", 0x97: "—", 0x9a: "š", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ" };

/** The text an entity stands for, or null when it isn't one we know. */
export function entityText(entity: string): string | null {
  const body = entity.slice(1, -1);
  const num = /^#(\d+)$/.exec(body) ?? /^#x([0-9a-f]+)$/i.exec(body);
  if (num) {
    const cp = parseInt(num[1]!, body[1] === "x" || body[1] === "X" ? 16 : 10);
    if (CP1252[cp]) return CP1252[cp]!;
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : null;
  }
  if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body]!;
  const accented = /^([A-Za-z])([a-z]+)$/.exec(body);
  if (accented && Object.hasOwn(ACCENT_MARKS, accented[2]!)) return (accented[1]! + ACCENT_MARKS[accented[2]!]!).normalize("NFC");
  return null;
}

/** Text as a reader sees it, each character tied to the span of the original it came from. */
interface View { text: string; start: number[]; end: number[] }

function readableView(text: string, from: number, to: number): View {
  const chunks: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const push = (s: string, a: number, b: number) => { chunks.push(s); for (let k = 0; k < s.length; k++) { start.push(a); end.push(b); } };
  const seg = text.slice(from, to);
  let at = 0;
  for (const m of seg.matchAll(MARKUP_RE)) {
    for (let k = at; k < m.index; k++) push(seg[k]!, from + k, from + k + 1);
    const a = from + m.index, b = a + m[0].length;
    push(m[0][0] === "<" ? " " : entityText(m[0]) ?? " ", a, b);
    at = m.index + m[0].length;
  }
  for (let k = at; k < seg.length; k++) push(seg[k]!, from + k, from + k + 1);
  return { text: chunks.join(""), start, end };
}

type Role = "given" | "surname" | "drop";
export interface NameMatch { start: number; end: number; hit: VariantHit; parts: { start: number; end: number; role: Role; shape: string }[] }
interface Tok { start: number; end: number; ve: number; shape: string; norm: string }

/** How two words of one name may be separated; a period right after an initial ("Q. Ashbury") counts as part of the space. */
function gapBetween(text: string, a: Tok, b: Tok): "join" | "comma" | null {
  let gap = text.slice(a.end, b.start);
  if (a.norm.length === 1 && gap.startsWith(".")) {
    gap = gap.slice(1);
    if (gap === "") return "join";
  }
  if (JOIN_GAP.test(gap)) return "join";
  if (COMMA_GAP.test(gap)) return "comma";
  return null;
}

function matchView(text: string, view: View, index: PeopleIndex, out: NameMatch[]): void {
  const toks: Tok[] = [...view.text.matchAll(TOKEN_RE)].map((m) => {
    const ve = m.index + m[0].length;
    return { start: view.start[m.index]!, end: view.end[ve - 1]!, ve, shape: m[0], norm: normToken(m[0]) };
  });
  for (let i = 0; i < toks.length; i++) {
    if (!index.firstTokens.has(toks[i]!.norm)) continue;
    let match: NameMatch | null = null;
    let used = 0;
    // One window longer than any variant, so a middle initial ("Quill A. Ashbury") can be skipped.
    for (let n = Math.min(index.maxWords + 1, toks.length - i); n >= 2 && !match; n--) {
      const last = i + n - 1;
      let commaAt = -1;
      let ok = true;
      for (let j = i + 1; j <= last && ok; j++) {
        const gap = gapBetween(text, toks[j - 1]!, toks[j]!);
        if (gap === "comma" && commaAt === -1) commaAt = j;
        else if (gap !== "join") ok = false;
      }
      if (!ok) continue;
      const words = toks.slice(i, i + n).map((t, k) => (i + k === last ? t.norm.replace(POSSESSIVE, "") : t.norm));
      const keyOf = (skip: number) => words.map((w, k) => (i + k === skip ? null : i + k === commaAt ? `, ${w}` : w)).filter((w) => w !== null).join(" ");
      let hit = index.byVariant.get(keyOf(-1));
      if (!hit && n >= 3) {
        const initials = words.map((_, k) => i + k).filter((j) => j > i && j < last && toks[j]!.norm.length === 1);
        if (initials.length === 1 && initials[0] !== commaAt && initials[0]! + 1 !== commaAt) hit = index.byVariant.get(keyOf(initials[0]!));
      }
      if (!hit) continue;
      const found = hit;
      const lastTok = toks[last]!;
      const poss = POSSESSIVE.exec(lastTok.shape);
      const parts = toks.slice(i, i + n).map((t, k) => {
        const j = i + k;
        const role: Role = found.surnameFirst ? (j === i ? "surname" : j === commaAt ? "given" : "drop") : j === i ? "given" : j === last ? "surname" : "drop";
        let start = t.start;
        let end = j === last && poss ? view.end[t.ve - poss[0].length - 1]! : t.end;
        if (role === "drop") {
          // Take the space before a dropped word with it, and an initial's period, so no double space is left.
          if (/^\s+$/.test(text.slice(toks[j - 1]!.end, t.start))) start = toks[j - 1]!.end;
          if (t.norm.length === 1 && j < last && text[end] === ".") end++;
        }
        return { start, end, role, shape: j === last && poss ? t.shape.slice(0, -poss[0].length) : t.shape };
      });
      match = { start: parts[0]!.start, end: parts[parts.length - 1]!.end, hit: found, parts };
      used = n;
    }
    if (match) { out.push(match); i += used - 1; }
  }
}

/** Names in running text and inside tags (alt, title and any other attribute value), with entities read as characters. */
export function nameSpans(text: string, index: PeopleIndex): NameMatch[] {
  const out: NameMatch[] = [];
  matchView(text, readableView(text, 0, text.length), index, out);
  for (const m of text.matchAll(TAG_RE)) matchView(text, readableView(text, m.index + 1, m.index + m[0].length - 1), index, out);
  return out.sort((a, b) => a.start - b.start);
}

function replaceSpans<T extends { start: number; end: number }>(text: string, spans: T[], f: (original: string, span: T) => string): string {
  let out = "";
  let at = 0;
  for (const sp of spans) { out += text.slice(at, sp.start) + f(text.slice(sp.start, sp.end), sp); at = sp.end; }
  return out + text.slice(at);
}
const upperIf = (original: string, s: string) => (original === original.toUpperCase() && original !== original.toLowerCase() ? s.toUpperCase() : s);

export function scrubText(text: string, ctx: ScrubCtx): { text: string; counts: Counts } {
  const counts: Counts = { names: 0, emails: 0, phones: 0 };
  let out = text.replace(EMAIL_RE, (m) => {
    const e = m.toLowerCase();
    if (e.endsWith(TEST_DOMAIN)) return m;
    counts.emails++;
    return ctx.index.byEmail.get(e)?.fake.email ?? fakeEmailFor(ctx.key, e);
  });
  out = replaceSpans(out, phoneSpans(out), (m, sp) => {
    if (FAKE_PHONE.test(m)) return m;
    counts.phones++;
    const f = fakePhone(ctx.key, m.replace(/\D/g, ""));
    return sp.local ? f.slice(4) : f;
  });
  const matches = nameSpans(out, ctx.index);
  counts.names += matches.length;
  const parts = matches.flatMap((m) => m.parts.map((p) => ({ ...p, fake: m.hit.person.fake })));
  out = replaceSpans(out, parts, (_orig, p) => {
    if (p.role === "drop") return "";
    const fake = p.role === "given" ? p.fake.first : p.fake.last;
    // An initial stays an initial: "Q. Ashbury" becomes "F. Last", not "First. Last".
    return upperIf(p.shape, p.role === "given" && p.shape.length === 1 ? fake[0]! : fake);
  });
  return { text: out, counts };
}

export type LeakKind = "name" | "name-plain" | "email" | "phone";

/**
 * A second, independent route to the same names: tags become spaces and their contents are searched on
 * their own, entities are decoded by plain replacement, the text is split on whitespace only, and each
 * run of words is looked up whole. It catches a tokenizer or gap-rule mistake in nameSpans, which would
 * otherwise hide from a gate that used nameSpans alone.
 */
const LEADING_PUNCT = /^[("'“‘[]+/;
const TRAILING_PUNCT = /[.,;:!?)\]"”']+$/;
const INITIAL_WORD = /^\p{L}\.?$/u;

function plainSegmentHits(segment: string, index: PeopleIndex): number {
  const words: string[] = [];
  for (const w of segment.split(/\s+/)) {
    if (w === "") continue;
    if (w === "," && words.length > 0) words[words.length - 1] += ",";
    else if (/^(?:\p{L}\.){2,}$/u.test(w)) words.push(...w.match(/\p{L}\./gu)!);
    else words.push(w);
  }
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(index.maxWords + 1, words.length - i); n >= 2; n--) {
      let comma = false;
      const ws = words.slice(i, i + n).map((w, k) => {
        let t = normToken(w);
        if (k === 0) {
          t = t.replace(LEADING_PUNCT, "");
          if (t.endsWith(",")) { comma = true; t = t.slice(0, -1); }
        }
        if (k === n - 1) return t.replace(TRAILING_PUNCT, "").replace(POSSESSIVE, "");
        return INITIAL_WORD.test(t) ? t.slice(0, 1) : t;
      });
      const keyOf = (skip: number) => ws.filter((_, k) => k !== skip).map((w, k) => (k === 1 && comma ? `, ${w}` : w)).join(" ");
      let found = index.byVariant.has(keyOf(-1));
      if (!found && n >= 3) {
        const initials = ws.map((w, k) => (k > 0 && k < n - 1 && INITIAL_WORD.test(w) ? k : -1)).filter((k) => k >= 0);
        if (initials.length === 1 && !(comma && initials[0] === 1)) found = index.byVariant.has(keyOf(initials[0]!));
      }
      if (found) { hits++; i += n - 1; break; }
    }
  }
  return hits;
}

export function plainNameHits(text: string, index: PeopleIndex): number {
  const inTags: string[] = [];
  const body = text.replace(/<([^<>]{0,200})>/g, (_, inner: string) => { inTags.push(inner); return " "; });
  // Quotes and equals signs become spaces too, so an attribute in a tag too long to read as one still splits into words.
  const decode = (s: string) => s.replace(/[="]/g, " ").replace(ENTITY_RE, (e) => entityText(e) ?? " ");
  return [body, ...inTags].reduce((sum, seg) => sum + plainSegmentHits(decode(seg), index), 0);
}

export function findLeaks(text: string, index: PeopleIndex): LeakKind[] {
  const kinds: LeakKind[] = [];
  for (const m of text.matchAll(EMAIL_RE)) if (!m[0].toLowerCase().endsWith(TEST_DOMAIN)) kinds.push("email");
  for (const sp of phoneSpans(text)) if (!FAKE_PHONE.test(text.slice(sp.start, sp.end))) kinds.push("phone");
  kinds.push(...nameSpans(text, index).map((): LeakKind => "name"));
  for (let i = plainNameHits(text, index); i > 0; i--) kinds.push("name-plain");
  return kinds;
}
