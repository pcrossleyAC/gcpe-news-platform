import { FAKE_PHONE, fakeEmailFor, fakePhone } from "./identity";
import { NAME_PARTICLES, normToken, TOKEN_RE, type PeopleIndex, type VariantHit } from "./people";

export const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** North American numbers with an area code: 604-555-0142, (604) 555-0142, 604.555.0142, +1 604 555 0142, 1-800-…, with ext./x. */
/** Separators are matched over entity-decoded text, so they include no-break and thin spaces and the Unicode hyphens and dashes. */
const FULL_PHONE_RE = /(?<![\w+\-\u2010-\u2013])(?:\+?1[ .\-\u00a0\u2000-\u200a\u202f\u2010-\u2013]?)?(?:\(\d{3}\)[ .\-\u00a0\u2000-\u200a\u202f\u2010-\u2013]?|\d{3}[ .\-\u00a0\u2000-\u200a\u202f\u2010-\u2013])\d{3}[ .\-\u00a0\u2000-\u200a\u202f\u2010-\u2013]\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?(?![\w\-\u2010-\u2013])/gi;
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
  nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", numsp: "\u2007", puncsp: "\u2008", hairsp: "\u200a", commat: "@", period: ".", hyphen: "\u2010", dash: "\u2010", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", shy: "",
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

function readableView(text: string, from: number, to: number, markup: RegExp = MARKUP_RE): View {
  const chunks: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const push = (s: string, a: number, b: number) => { chunks.push(s); for (let k = 0; k < s.length; k++) { start.push(a); end.push(b); } };
  const seg = text.slice(from, to);
  let at = 0;
  for (const m of seg.matchAll(markup)) {
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
/** A word, or one piece of a word joined by hyphens or dashes ("Ashbury–Thea" is two pieces of one word). */
interface Tok { start: number; end: number; vs: number; ve: number; shape: string; norm: string; word: number; joined: boolean; cut: boolean }
/** Consecutive pieces of one word inside a window, joined back with a hyphen. */
interface Group { start: number; end: number; vs: number; shape: string; norm: string; last: number }

/** How two words of one name may be separated; a period right after an initial ("Q. Ashbury") counts as part of the space. */
function gapBetween(text: string, a: { end: number; norm: string }, b: { start: number }): "join" | "comma" | null {
  let gap = text.slice(a.end, b.start);
  if (a.norm.length === 1 && gap.startsWith(".")) {
    gap = gap.slice(1);
    if (gap === "") return "join";
  }
  if (JOIN_GAP.test(gap)) return "join";
  if (COMMA_GAP.test(gap)) return "comma";
  return null;
}

const DASHES = /[-\u2010\u2011\u2013]/g;
/** A piece of a name is capitalised, or is a lower-case particle ("de", "van"), or reads like "d'Arcy". */
const nameCased = (piece: string) => /^\p{Lu}/u.test(piece) || NAME_PARTICLES.has(normToken(piece)) || /^\p{Ll}{1,3}['’]\p{Lu}/u.test(piece);
const upperCased = (piece: string) => /\p{Lu}/u.test(piece) && !/\p{Ll}/u.test(piece);
/** All-upper-case runs this long are shouted headlines ("MARK SHORT-TERM GAINS"), not names. */
const SHOUTED = 4;
/**
 * Only words written like a name are replaced: each capitalised (particles aside), or all of them upper case outside a
 * shouted run. Lower-case and mixed matches ("asked Kevin to", "news staff", "to mark short-term gains") are left
 * alone; Gate 1's literal route is case-insensitive, so a real name left that way fails the gate loudly.
 */
function writtenLikeName(pieces: string[], run: () => number): boolean {
  if (pieces.every(upperCased)) return run() < SHOUTED;
  return pieces.every(nameCased);
}

function piecesOf(view: View): Tok[] {
  const toks: Tok[] = [];
  let word = 0;
  for (const m of view.text.matchAll(TOKEN_RE)) {
    const cuts = [...m[0].matchAll(DASHES)].map((d) => d.index);
    let at = 0;
    for (const c of [...cuts, m[0].length]) {
      const vs = m.index + at, ve = m.index + c;
      const shape = m[0].slice(at, c);
      toks.push({ start: view.start[vs]!, end: view.end[ve - 1]!, vs, ve, shape, norm: normToken(shape), word, joined: at > 0, cut: c < m[0].length });
      at = c + 1;
    }
    word++;
  }
  return toks;
}

function groupsOf(view: View, toks: Tok[], a: number, b: number): Group[] {
  const groups: Group[] = [];
  for (let j = a; j <= b; j++) {
    const t = toks[j]!;
    const g = groups[groups.length - 1];
    if (g && toks[g.last]!.word === t.word) {
      g.last = j; g.end = t.end; g.shape = view.text.slice(g.vs, t.ve); g.norm += `-${t.norm}`;
    } else groups.push({ start: t.start, end: t.end, vs: t.vs, shape: t.shape, norm: t.norm, last: j });
  }
  return groups;
}

function matchView(text: string, view: View, index: PeopleIndex, out: NameMatch[]): void {
  const toks = piecesOf(view);
  const cap = index.maxWords + 1;
  const adjacent = (x: number) => toks[x + 1]!.word === toks[x]!.word || gapBetween(text, toks[x]!, toks[x + 1]!) === "join";
  const runAround = (a: number, b: number) => {
    let lo = a, hi = b;
    while (lo > 0 && b - lo < SHOUTED && upperCased(toks[lo - 1]!.shape) && adjacent(lo - 1)) lo--;
    while (hi < toks.length - 1 && hi - lo < SHOUTED && upperCased(toks[hi + 1]!.shape) && adjacent(hi)) hi++;
    return hi - lo + 1;
  };
  const tryWindow = (a: number, b: number): NameMatch | null => {
    const groups = groupsOf(view, toks, a, b);
    const n = groups.length;
    if (n < 2 || !index.firstTokens.has(groups[0]!.norm)) return null;
    let commaAt = -1;
    for (let k = 1; k < n; k++) {
      const gap = gapBetween(text, groups[k - 1]!, groups[k]!);
      if (gap === "comma" && commaAt === -1) commaAt = k;
      else if (gap !== "join") return null;
    }
    const lastG = groups[n - 1]!;
    const poss = toks[b]!.cut ? null : POSSESSIVE.exec(lastG.shape);
    const keep = lastG.shape.length - (poss ? poss[0].length : 0);
    const words = groups.map((g, k) => (k === n - 1 && poss ? g.norm.replace(POSSESSIVE, "") : g.norm));
    const keyOf = (skip: number) => words.map((w, k) => (k === skip ? null : k === commaAt ? `, ${w}` : w)).filter((w) => w !== null).join(" ");
    let hit = index.byVariant.get(keyOf(-1));
    if (!hit && n >= 3) {
      // One middle initial may be skipped ("Quill A. Ashbury").
      const initials = words.map((_, k) => k).filter((k) => k > 0 && k < n - 1 && words[k]!.length === 1);
      if (initials.length === 1 && initials[0] !== commaAt && initials[0]! + 1 !== commaAt) hit = index.byVariant.get(keyOf(initials[0]!));
    }
    if (!hit || !writtenLikeName(toks.slice(a, b + 1).map((t) => t.shape), () => runAround(a, b))) return null;
    // A name cut from the front of a word is followed by a lower-case suffix ("Ashbury-led") or by another name
    // ("Ashbury–Thea Marchbank"), never by a capitalised word of its own ("Mark Short-Term").
    if (toks[b]!.cut && !/^\p{Ll}/u.test(toks[b + 1]!.shape) && !matchAt(b + 1)) return null;
    const found = hit;
    const parts = groups.map((g, k) => {
      const role: Role = found.surnameFirst ? (k === 0 ? "surname" : k === commaAt ? "given" : "drop") : k === 0 ? "given" : k === n - 1 ? "surname" : "drop";
      let start = g.start;
      let end = k === n - 1 ? view.end[g.vs + keep - 1]! : g.end;
      if (role === "drop") {
        // Take the space before a dropped word with it, and an initial's period, so no double space is left.
        if (/^\s+$/.test(text.slice(groups[k - 1]!.end, g.start))) start = groups[k - 1]!.end;
        if (g.norm.length === 1 && text[end] === ".") end++;
      }
      return { start, end, role, shape: k === n - 1 ? g.shape.slice(0, keep) : g.shape };
    });
    return { start: parts[0]!.start, end: parts[parts.length - 1]!.end, hit: found, parts };
  };
  const memo = new Map<number, { match: NameMatch; last: number } | null>();
  function matchAt(i: number): { match: NameMatch; last: number } | null {
    if (memo.has(i)) return memo.get(i)!;
    memo.set(i, null);
    let head = toks[i]!.norm;
    let starts = index.firstTokens.has(head);
    for (let j = i + 1; !starts && j < toks.length && j - i < cap && toks[j]!.word === toks[i]!.word; j++) starts = index.firstTokens.has((head += `-${toks[j]!.norm}`));
    let found: { match: NameMatch; last: number } | null = null;
    if (starts) {
      // The window may end inside a word ("Ashbury-led") and reaches one word past the longest variant, so a middle
      // initial can be skipped; the longest window that names someone wins. A word counts for at most that many pieces.
      let far = i;
      for (let j = i + 1, words = 1, pieces = 1; j < toks.length; j++) {
        if (toks[j]!.word !== toks[j - 1]!.word) { words++; pieces = 1; } else pieces++;
        if (words > cap || pieces > cap) break;
        far = j;
      }
      for (let b = far; b > i && !found; b--) { const m = tryWindow(i, b); if (m) found = { match: m, last: b }; }
    }
    memo.set(i, found);
    return found;
  }
  for (let i = 0; i < toks.length; i++) {
    const m = matchAt(i);
    if (m) { out.push(m.match); i = m.last; }
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

/** Emails and phones over the text with entities decoded (tags kept, so mailto: links count), as spans of the original. */
function contactSpans(text: string): { start: number; end: number; kind: "email" | "phone"; value: string; local: boolean }[] {
  const view = readableView(text, 0, text.length, ENTITY_RE);
  const span = (a: number, b: number) => ({ start: view.start[a]!, end: view.end[b - 1]!, value: view.text.slice(a, b) });
  const out: { start: number; end: number; kind: "email" | "phone"; value: string; local: boolean }[] = [];
  for (const m of view.text.matchAll(EMAIL_RE)) if (!m[0].toLowerCase().endsWith(TEST_DOMAIN)) out.push({ ...span(m.index, m.index + m[0].length), kind: "email", local: false });
  for (const sp of phoneSpans(view.text)) {
    const v = span(sp.start, sp.end);
    if (!FAKE_PHONE.test(v.value) && !out.some((x) => v.start < x.end && v.end > x.start)) out.push({ ...v, kind: "phone", local: sp.local });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function scrubText(text: string, ctx: ScrubCtx): { text: string; counts: Counts } {
  const counts: Counts = { names: 0, emails: 0, phones: 0 };
  let out = replaceSpans(text, contactSpans(text), (_orig, sp) => {
    if (sp.kind === "email") {
      counts.emails++;
      const e = sp.value.toLowerCase();
      return ctx.index.byEmail.get(e)?.fake.email ?? fakeEmailFor(ctx.key, e);
    }
    counts.phones++;
    const f = fakePhone(ctx.key, sp.value.replace(/\D/g, ""));
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

/** Splits a word at a hyphen or dash between two other characters, so "Ashbury–Thea" yields both names' pieces. */
const PLAIN_DASH = /(?<=[^\s\-\u2010\u2011\u2013])[-\u2010\u2011\u2013](?=[^\s\-\u2010\u2011\u2013])/u;

function plainSegmentHits(segment: string, index: PeopleIndex): number {
  const words: string[] = [];
  for (const w of segment.split(/\s+/)) {
    if (w === "") continue;
    if (w === "," && words.length > 0) words[words.length - 1] += ",";
    else if (/^(?:\p{L}\.){2,}$/u.test(w)) words.push(...w.match(/\p{L}\./gu)!);
    else words.push(w);
  }
  const subs = words.flatMap((w, word) => w.split(PLAIN_DASH).map((raw, k, all) => ({ raw, word, joined: k > 0, cut: k < all.length - 1 })));
  const cap = index.maxWords + 1;
  const bare = (raw: string) => raw.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");
  // Two pieces are side by side when they share a word, or when no punctuation sits between their words.
  const adjacent = (x: number) => subs[x + 1]!.word === subs[x]!.word || (!TRAILING_PUNCT.test(subs[x]!.raw) && !LEADING_PUNCT.test(subs[x + 1]!.raw));
  const runAround = (a: number, b: number) => {
    let lo = a, hi = b;
    while (lo > 0 && b - lo < SHOUTED && upperCased(bare(subs[lo - 1]!.raw)) && adjacent(lo - 1)) lo--;
    while (hi < subs.length - 1 && hi - lo < SHOUTED && upperCased(bare(subs[hi + 1]!.raw)) && adjacent(hi)) hi++;
    return hi - lo + 1;
  };
  const memo = new Map<number, number | null>();
  /** The last piece of the name starting at piece i, or null. */
  function nameAt(i: number): number | null {
    if (memo.has(i)) return memo.get(i)!;
    memo.set(i, null);
    let far = i;
    for (let j = i + 1, count = 1, pieces = 1; j < subs.length; j++) {
      if (subs[j]!.word !== subs[j - 1]!.word) { count++; pieces = 1; } else pieces++;
      if (count > cap || pieces > cap) break;
      far = j;
    }
    let found: number | null = null;
    for (let b = far; b > i && found === null; b--) {
      const groups: string[] = [];
      for (let j = i; j <= b; j++) {
        if (j > i && subs[j]!.word === subs[j - 1]!.word) groups[groups.length - 1] += `-${subs[j]!.raw}`;
        else groups.push(subs[j]!.raw);
      }
      const n = groups.length;
      if (n < 2) continue;
      let comma = false;
      const ws = groups.map((g, k) => {
        let t = normToken(g);
        if (k === 0) {
          t = t.replace(LEADING_PUNCT, "");
          if (t.endsWith(",")) { comma = true; t = t.slice(0, -1); }
        }
        if (k === n - 1) return subs[b]!.cut ? t : t.replace(TRAILING_PUNCT, "").replace(POSSESSIVE, "");
        return INITIAL_WORD.test(t) ? t.slice(0, 1) : t;
      });
      const keyOf = (skip: number) => ws.filter((_, k) => k !== skip).map((w, k) => (k === 1 && comma ? `, ${w}` : w)).join(" ");
      let hit = index.byVariant.has(keyOf(-1));
      if (!hit && n >= 3) {
        const initials = ws.map((w, k) => (k > 0 && k < n - 1 && INITIAL_WORD.test(w) ? k : -1)).filter((k) => k >= 0);
        if (initials.length === 1 && !(comma && initials[0] === 1)) hit = index.byVariant.has(keyOf(initials[0]!));
      }
      if (!hit || !writtenLikeName(subs.slice(i, b + 1).map((x) => bare(x.raw)), () => runAround(i, b))) continue;
      if (subs[b]!.cut && !/^\p{Ll}/u.test(subs[b + 1]!.raw) && nameAt(b + 1) === null) continue;
      found = b;
    }
    memo.set(i, found);
    return found;
  }
  let hits = 0;
  for (let i = 0; i < subs.length; i++) {
    const last = nameAt(i);
    if (last !== null) { hits++; i = last; }
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

/** The plain route for emails and phones: entities decoded by straight replacement, then the patterns run over the result. */
export function plainContactHits(text: string): { emails: number; phones: number } {
  const decoded = text.replace(ENTITY_RE, (e) => entityText(e) ?? " ");
  const emails = [...decoded.matchAll(EMAIL_RE)].filter((m) => !m[0].toLowerCase().endsWith(TEST_DOMAIN)).length;
  const phones = phoneSpans(decoded).filter((sp) => !FAKE_PHONE.test(decoded.slice(sp.start, sp.end))).length;
  return { emails, phones };
}

export function findLeaks(text: string, index: PeopleIndex): LeakKind[] {
  const kinds: LeakKind[] = [];
  const strict = contactSpans(text);
  const plain = plainContactHits(text);
  // Either route seeing more than the other is a leak the other missed, so the larger count is reported.
  for (let i = Math.max(strict.filter((x) => x.kind === "email").length, plain.emails); i > 0; i--) kinds.push("email");
  for (let i = Math.max(strict.filter((x) => x.kind === "phone").length, plain.phones); i > 0; i--) kinds.push("phone");
  kinds.push(...nameSpans(text, index).map((): LeakKind => "name"));
  for (let i = plainNameHits(text, index); i > 0; i--) kinds.push("name-plain");
  return kinds;
}
