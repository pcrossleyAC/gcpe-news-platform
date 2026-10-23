import { createIdentityAllocator, type FakeIdentity } from "./identity";

export interface PersonSource {
  source: string;
  id: string;
  names: (string | null)[];
  email: string | null;
  phones: (string | null)[];
  /** A row that names another row's person (a comm contact's user). */
  linkId?: string | null;
  linkSource?: string;
  /** User rows always get an identity, even when their name can't be parsed. */
  alwaysPerson?: boolean;
}
export interface Person { key: string; names: string[]; emails: string[]; phones: string[]; sources: string[]; fake: FakeIdentity }
export interface VariantHit { person: Person; surnameFirst: boolean }
export interface PeopleIndex {
  persons: Person[];
  bySource: Map<string, Person>;
  byVariant: Map<string, VariantHit>;
  byEmail: Map<string, Person>;
  firstTokens: Set<string>;
  maxWords: number;
}

/**
 * A word: letters and marks, with an apostrophe or hyphen only between letters (O'Neil, Tennant-Vey), so a closing
 * quote or plural possessive stays outside. Non-breaking hyphens and en dashes inside a name count as hyphens.
 */
export const TOKEN_RE = /[\p{L}\p{M}](?:[\p{L}\p{M}]|['’\-‐‑–](?=[\p{L}\p{M}]))*/gu;
const HONORIFICS = new Set(["hon", "honourable", "honorable", "the", "rt", "right", "dr", "mr", "mrs", "ms", "mx", "miss", "sir", "dame", "prof", "professor", "rev", "reverend"]);
/** Office words in government and First Nations usage; everything up to the last of them before a name is the office. */
const TITLES = new Set([
  "premier", "minister", "ministers", "deputy", "assistant", "associate", "parliamentary", "secretary", "mla", "mp", "chief", "chair",
  "chairperson", "acting", "interim", "executive", "director", "president", "vice", "officer", "attorney", "solicitor", "general",
  "speaker", "leader", "commissioner", "mayor", "councillor", "senior", "special", "advisor", "adviser", "grand", "regional", "elder",
  "board", "lieutenant", "governor", "provincial", "chancellor", "ambassador", "consul", "registrar", "auditor", "comptroller",
  "ombudsperson", "ombudsman", "clerk", "superintendent", "inspector", "commander", "captain", "councillors", "manager", "coordinator",
]);
/** Words that tie an office to its portfolio or its principal ("Minister of State for Trade", "Secretary to Cabinet"). A name never contains them. */
const LINKS = new Set(["of", "for", "and", "to", "on", "the", "responsible", "state"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "kc", "qc", "phd", "md", "mla", "mp"]);
/** A multi-word part before the comma is a surname only when it starts like one ("Van Dyk, Quill"); otherwise it is "Name, office". */
const SURNAME_PARTICLES = new Set(["van", "von", "de", "del", "della", "der", "den", "di", "du", "da", "dos", "das", "la", "le", "st", "ter", "ten", "mac", "mc", "bin", "ibn", "al", "el"]);
/** Names made only of these are roles or placeholders, not people. */
const ROLE_WORDS = new Set([
  "premier", "minister", "deputy", "parliamentary", "secretary", "mla", "mp", "assistant", "associate", "acting", "staff", "team",
  "office", "tbd", "tba", "none", "other", "various", "multiple", "ministry", "unknown", "gcpe", "communications", "media",
  "relations", "director", "executive", "chief", "of", "and", "for", "government", "representative", "events", "event",
  "planner", "videographer", "photographer", "coordinator", "admin", "administrator", "system", "test", "user", "hq",
]);
/**
 * Words that end an office title ("Chief Information Officer", "Board Chair"). A parse whose surname is one of these is
 * an office, not a person. Office words that are also common surnames (Mayor, Speaker, Leader, Elder, General) are left out.
 */
const OFFICE_ENDS = new Set([
  "officer", "secretary", "minister", "ministers", "premier", "chair", "chairperson", "president", "commissioner", "advisor", "adviser",
  "councillor", "councillors", "deputy", "assistant", "associate", "executive", "director", "coordinator", "manager", "governor",
  "lieutenant", "provincial", "regional", "board", "cabinet", "council", "committee", "registrar", "auditor", "comptroller",
  "ombudsperson", "ombudsman", "clerk", "superintendent", "inspector", "chancellor", "ambassador", "consul",
]);
const isRole = (t: string) => ROLE_WORDS.has(t) || TITLES.has(t) || HONORIFICS.has(t) || LINKS.has(t);
/** What a part after a comma starts with when it describes the person rather than naming them ("…, MLA", "…, Minister of Health", "…, Jr."). */
const isDescriptor = (t: string) => ROLE_WORDS.has(t) || TITLES.has(t) || SUFFIXES.has(t);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normToken(t: string): string {
  return t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/’/g, "'").replace(/[‐‑–]/g, "-");
}

export function normEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

type ParsedName = { given: string[]; surname: string[] };
const tokensOf = (raw: string) => [...raw.matchAll(TOKEN_RE)].map((m) => normToken(m[0]));
const withoutInitials = (t: string[]) => t.filter((w) => w.length > 1);

function stripTitles(t: string[]): { rest: string[]; portfolio: boolean } {
  let i = 0;
  let portfolio = false;
  while (i < t.length && (TITLES.has(t[i]!) || HONORIFICS.has(t[i]!) || LINKS.has(t[i]!))) { if (LINKS.has(t[i]!) && !HONORIFICS.has(t[i]!)) portfolio = true; i++; }
  return { rest: t.slice(i), portfolio };
}
function stripSuffixes(t: string[]): string[] {
  let j = t.length;
  while (j > 0 && SUFFIXES.has(t[j - 1]!)) j--;
  return t.slice(0, j);
}

function givenFirst(words: string[]): ParsedName | null {
  let rest = stripSuffixes(words);
  // "Health Minister Quill Ashbury", "Grand Chief …", "Provincial Health Officer Dr. …": whatever comes before the last
  // office word or honorific that still leaves two words is the office.
  let cut = -1;
  for (let k = 0; k <= rest.length - 3; k++) if (TITLES.has(rest[k]!) || HONORIFICS.has(rest[k]!)) cut = k;
  rest = rest.slice(cut + 1);
  const stripped = stripTitles(rest);
  rest = stripped.rest;
  if (stripped.portfolio) {
    // "Minister of Health Quill Ashbury": the portfolio runs from the last link word; the name is the two words after it.
    let k = rest.length;
    while (k > 0 && !LINKS.has(rest[k - 1]!)) k--;
    rest = rest.slice(k);
    if (rest.length < 3) return null;
    rest = rest.slice(-2);
  }
  if (rest.length < 2) return null;
  return { given: rest.slice(0, -1), surname: rest.slice(-1) };
}

function surnameFirst(head: string[], tail: string[]): ParsedName | null {
  const surname = withoutInitials(stripTitles(head).rest);
  const given = stripSuffixes(stripTitles(tail).rest);
  const named = withoutInitials(given);
  return surname.length > 0 && given.length > 0 ? { given: named.length > 0 ? named : given, surname } : null;
}

/** Middle initials are dropped, but a lone initial is kept as the given name ("Q. Ashbury"). */
const initialsAware = (words: string[], f: (w: string[]) => ParsedName | null) => f(withoutInitials(words)) ?? f(words);

function parseCandidate(s: string): ParsedName | null {
  if (/[\d@]/.test(s)) return null;
  const parts = s.split(",").map(tokensOf).filter((p) => p.length > 0);
  while (parts.length > 1 && isDescriptor(parts[parts.length - 1]![0]!)) parts.pop();
  if (parts.length === 0) return null;
  let p: ParsedName | null;
  if (parts.length === 1) p = initialsAware(parts[0]!, givenFirst);
  else {
    // A head that held a portfolio ("Minister of Tourism, Arts, …") is an office list, never "Surname, Given".
    const { rest, portfolio } = stripTitles(parts[0]!);
    const head = withoutInitials(rest);
    p = portfolio || (head.length >= 2 && !SURNAME_PARTICLES.has(head[0]!)) ? initialsAware(parts[0]!, givenFirst) : surnameFirst(parts[0]!, parts[1]!);
  }
  if (!p || p.given.length === 0 || p.surname.length === 0 || p.given.length + p.surname.length > 4) return null;
  if (p.surname.some((t) => t.length < 2)) return null;
  const all = [...p.given, ...p.surname];
  if (all.some((t) => LINKS.has(t)) || p.surname.some((t) => OFFICE_ENDS.has(t) || ROLE_WORDS.has(t)) || all.every(isRole)) return null;
  return p;
}

/**
 * A person's name as given names and surname, or null for roles, placeholders and anything that isn't a name.
 * Offices and honorifics in front, suffixes and descriptions after a comma, and a parenthesised note are not
 * part of the name; when the text outside the brackets isn't a name, the text inside them is tried.
 */
export function parseName(raw: string | null): ParsedName | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "") return null;
  const outside = s.replace(/\([^()]*\)/g, " ");
  const inside = [...s.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!);
  for (const c of [outside, ...inside]) {
    const p = parseCandidate(c);
    if (p) return p;
  }
  return null;
}

export interface NameVariant { key: string; surnameFirst: boolean; fallback?: true }

/**
 * The forms a name is matched in. With more than one given word, the last given word plus the surname is a fallback:
 * it catches a name behind an office the role lists don't know ("Grand Poobah Quill Ashbury"), and gives way to any
 * other person's own variant.
 */
export function nameVariants(raw: string | null): NameVariant[] {
  const p = parseName(raw);
  if (!p) return [];
  const first = p.given[0]!;
  const last = p.surname.join(" ");
  const v = new Map<string, boolean>([
    [[...p.given, last].join(" "), false],
    [`${first} ${last}`, false],
    [`${last} , ${p.given.join(" ")}`, true],
    [`${last} , ${first}`, true],
  ]);
  const out: NameVariant[] = [...v].map(([key, surnameFirst]) => ({ key, surnameFirst }));
  const lastGiven = p.given[p.given.length - 1]!;
  const fallback = `${lastGiven} ${last}`;
  if (p.given.length > 1 && lastGiven.length > 1 && !isRole(lastGiven) && !v.has(fallback)) out.push({ key: fallback, surnameFirst: false, fallback: true });
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Draft { key: string; names: Set<string>; emails: Set<string>; phones: Set<string>; sources: Set<string> }

export function buildPeopleIndex(sources: PersonSource[], key: string, reservedEmails: ReadonlySet<string> = new Set()): PeopleIndex {
  const drafts = new Map<string, Draft>();
  const byCanonical = new Map<string, Draft>();
  const sourceDraft = new Map<string, Draft>();
  const draft = (k: string) => {
    let d = drafts.get(k);
    if (!d) { d = { key: k, names: new Set(), emails: new Set(), phones: new Set(), sources: new Set() }; drafts.set(k, d); }
    return d;
  };
  const sk = (s: PersonSource) => `${s.source}:${s.id}`;
  const canonicalOf = (s: PersonSource) => {
    for (const n of s.names) { const p = parseName(n); if (p) return [...p.given, ...p.surname].join(" "); }
    return null;
  };
  const add = (d: Draft, s: PersonSource) => {
    for (const n of s.names) if (n && n.trim()) d.names.add(n.trim());
    const e = normEmail(s.email);
    if (e) d.emails.add(e);
    for (const p of s.phones) if (p && p.trim()) d.phones.add(p.trim());
    d.sources.add(sk(s));
    sourceDraft.set(sk(s), d);
    const c = canonicalOf(s);
    if (c && !byCanonical.has(c)) byCanonical.set(c, d);
  };
  const sorted = [...sources].sort((a, b) => cmp(sk(a), sk(b)));
  const linked = (s: PersonSource) => !!s.linkId && !!s.linkSource;
  // Emails first: they are the strongest evidence two rows are one person.
  for (const s of sorted) { const e = normEmail(s.email); if (e) add(draft(`e:${e}`), s); }
  // Then names, joining a person who already has that name.
  for (const s of sorted) {
    if (sourceDraft.has(sk(s)) || linked(s)) continue;
    const c = canonicalOf(s);
    if (c) add(byCanonical.get(c) ?? draft(`n:${c}`), s);
  }
  // Every user row is a person, named or not.
  for (const s of sorted) if (!sourceDraft.has(sk(s)) && s.alwaysPerson) add(draft(`s:${sk(s)}`), s);
  // Rows that name another row's person join that person.
  for (const s of sorted) {
    if (sourceDraft.has(sk(s)) || !linked(s)) continue;
    const target = sourceDraft.get(`${s.linkSource}:${s.linkId}`);
    const c = canonicalOf(s);
    if (target) add(target, s);
    else if (c) add(byCanonical.get(c) ?? draft(`n:${c}`), s);
  }

  const forbidden = new Set<string>();
  for (const d of drafts.values()) for (const n of d.names) for (const v of nameVariants(n)) if (!v.surnameFirst) forbidden.add(v.key);
  const allocator = createIdentityAllocator(key, { forbiddenNames: forbidden, reservedEmails });
  const persons: Person[] = [...drafts.values()].sort((a, b) => cmp(a.key, b.key)).map((d) => ({
    key: d.key, names: [...d.names].sort(cmp), emails: [...d.emails].sort(cmp), phones: [...d.phones].sort(cmp), sources: [...d.sources].sort(cmp), fake: allocator.allocate(d.key),
  }));

  const index: PeopleIndex = { persons, bySource: new Map(), byVariant: new Map(), byEmail: new Map(), firstTokens: new Set(), maxWords: 0 };
  // Fallback variants go in last, so they never take a form that is some other person's own name.
  for (const fallback of [false, true]) {
    for (const p of persons) for (const n of p.names) for (const v of nameVariants(n)) if (!!v.fallback === fallback && !index.byVariant.has(v.key)) index.byVariant.set(v.key, { person: p, surnameFirst: v.surnameFirst });
  }
  for (const p of persons) {
    for (const e of p.emails) if (!index.byEmail.has(e)) index.byEmail.set(e, p);
    for (const s of p.sources) index.bySource.set(s, p);
  }
  for (const k of index.byVariant.keys()) {
    const words = k.split(" ").filter((w) => w !== ",");
    index.firstTokens.add(words[0]!);
    index.maxWords = Math.max(index.maxWords, words.length);
  }
  return index;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** The real-to-fictional table. It holds real names: write it only with writePrivate. */
export function mappingCsv(index: PeopleIndex): string {
  const rows = index.persons.map((p) => [p.key, p.names.join(" | "), p.emails.join(" | "), p.fake.full, p.fake.email, p.fake.phone].map(csvCell).join(","));
  return ["person_key,real_names,real_emails,fake_name,fake_email,fake_phone", ...rows].join("\n") + "\n";
}
