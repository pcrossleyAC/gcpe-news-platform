import { FAKE_PHONE, fakeEmailFor, fakePhone } from "./identity";
import { normToken, TOKEN_RE, type PeopleIndex, type VariantHit } from "./people";

export const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** North American numbers with an area code: 604-555-0142, (604) 555-0142, 604.555.0142, +1 604 555 0142, 1-800-…, with ext./x. */
const FULL_PHONE_RE = /(?<![\w+-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?(?![\w-])/gi;
/** Seven-digit local numbers, only with a hyphen or dot, so years, ids and keys aren't mistaken for them. */
const LOCAL_PHONE_RE = /(?<![\w+.-])\d{3}[.-]\d{4}(?![\w.-])/g;
const TEST_DOMAIN = "@example.test";

export interface Counts { names: number; emails: number; phones: number }
export interface ScrubCtx { index: PeopleIndex; key: string }
type Role = "given" | "surname" | "drop";
export interface NameMatch { start: number; end: number; hit: VariantHit; parts: { start: number; end: number; role: Role }[] }

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
const COMMA_GAP = /^,(?:\s|&nbsp;|&#160;|&#xa0;)*$/i;
const POSSESSIVE = /['’]s$/i;

/** Tags and entities, blanked out before finding words so `<b>` or `&nbsp;` never reads as a word. */
const MARKUP_RE = /<[^<>]{0,200}>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi;

export function nameSpans(text: string, index: PeopleIndex): NameMatch[] {
  const masked = text.replace(MARKUP_RE, (m) => " ".repeat(m.length));
  const toks = [...masked.matchAll(TOKEN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length, norm: normToken(m[0]) }));
  const out: NameMatch[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!index.firstTokens.has(toks[i]!.norm)) continue;
    let match: NameMatch | null = null;
    let used = 0;
    for (let n = Math.min(index.maxWords, toks.length - i); n >= 2 && !match; n--) {
      let key = toks[i]!.norm;
      let commaAt = -1;
      let ok = true;
      for (let j = i + 1; j < i + n; j++) {
        const gap = text.slice(toks[j - 1]!.end, toks[j]!.start);
        if (JOIN_GAP.test(gap)) key += " ";
        else if (commaAt === -1 && COMMA_GAP.test(gap)) { key += " , "; commaAt = j; }
        else { ok = false; break; }
        key += j === i + n - 1 ? toks[j]!.norm.replace(POSSESSIVE, "") : toks[j]!.norm;
      }
      if (!ok) continue;
      const hit = index.byVariant.get(key);
      if (!hit) continue;
      const last = toks[i + n - 1]!;
      const poss = POSSESSIVE.exec(text.slice(last.start, last.end));
      const parts = toks.slice(i, i + n).map((t, k) => {
        const j = i + k;
        const end = j === i + n - 1 && poss ? t.end - poss[0].length : t.end;
        const role: Role = hit.surnameFirst ? (j === i ? "surname" : j === commaAt ? "given" : "drop") : j === i ? "given" : j === i + n - 1 ? "surname" : "drop";
        return { start: t.start, end, role };
      });
      match = { start: toks[i]!.start, end: parts[parts.length - 1]!.end, hit, parts };
      used = n;
    }
    if (match) { out.push(match); i += used - 1; }
  }
  return out;
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
  out = replaceSpans(out, parts, (orig, p) => (p.role === "drop" ? "" : upperIf(orig, p.role === "given" ? p.fake.first : p.fake.last)));
  return { text: out, counts };
}

export type LeakKind = "name" | "name-plain" | "email" | "phone";

/**
 * A second, independent route to the same names: tags and entities become spaces, the text is
 * split on whitespace only, and each run of words is looked up whole. It catches a tokenizer or
 * gap-rule mistake in nameSpans, which would otherwise hide from a gate that used nameSpans alone.
 */
const LEADING_PUNCT = /^[("'“‘[]+/;
const TRAILING_PUNCT = /[.,;:!?)\]"”]+$/;

export function plainNameHits(text: string, index: PeopleIndex): number {
  const words = text.replace(/<[^<>]{0,200}>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").split(/\s+/).filter(Boolean);
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(index.maxWords, words.length - i); n >= 2; n--) {
      const key = words.slice(i, i + n).map((w, k) => {
        let t = normToken(w);
        if (k === 0) t = t.replace(LEADING_PUNCT, "");
        if (k === 0 && t.endsWith(",")) t = `${t.slice(0, -1)} ,`;
        if (k === n - 1) t = t.replace(TRAILING_PUNCT, "").replace(POSSESSIVE, "");
        return t;
      }).join(" ");
      if (index.byVariant.has(key)) { hits++; i += n - 1; break; }
    }
  }
  return hits;
}

export function findLeaks(text: string, index: PeopleIndex): LeakKind[] {
  const kinds: LeakKind[] = [];
  for (const m of text.matchAll(EMAIL_RE)) if (!m[0].toLowerCase().endsWith(TEST_DOMAIN)) kinds.push("email");
  for (const sp of phoneSpans(text)) if (!FAKE_PHONE.test(text.slice(sp.start, sp.end))) kinds.push("phone");
  kinds.push(...nameSpans(text, index).map((): LeakKind => "name"));
  for (let i = plainNameHits(text, index); i > 0; i--) kinds.push("name-plain");
  return kinds;
}
