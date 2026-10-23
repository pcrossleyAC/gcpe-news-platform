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
  /** User and crew rows always get an identity, even when their name can't be parsed. */
  alwaysPerson?: boolean;
}
export type Stray = PersonSource & { fake: FakeIdentity };
/** Sources whose people hold public office (MLAs, ministers): their names may stay in text, their contacts may not. */
export const PUBLIC_OFFICE_SOURCES = ["calendar.GovernmentRepresentative", "dbo.Ministry"] as const;
export interface Person { key: string; names: string[]; emails: string[]; phones: string[]; sources: string[]; fake: FakeIdentity }
export interface VariantHit { person: Person; surnameFirst: boolean }
export interface PeopleIndex {
  persons: Person[];
  bySource: Map<string, Person>;
  byVariant: Map<string, VariantHit>;
  byEmail: Map<string, Person>;
  firstTokens: Set<string>;
  maxWords: number;
  /**
   * Rows that joined no person: their stored names, emails and phones are still searched for by the literal route,
   * and each has a fictional identity of its own so a mention of it can be replaced.
   */
  strays: Stray[];
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
/** Words that tie an office to its portfolio or its principal ("Minister of State for Trade", "Secretary to Cabinet"). A name rarely contains them. */
export const LINKS = new Set(["of", "for", "and", "to", "on", "the", "responsible", "state"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "kc", "qc", "phd", "md", "mla", "mp"]);
/** A multi-word part before the comma is a surname only when it starts like one ("Van Dyk, Quill"); otherwise it is "Name, office". */
const SURNAME_PARTICLES = new Set(["van", "von", "de", "del", "della", "der", "den", "di", "du", "da", "dos", "das", "la", "le", "st", "ter", "ten", "mac", "mc", "bin", "ibn", "al", "el"]);
/** Short words a given name is never, so "in Surrey" is not read as one person's fallback form. */
const FUNCTION_WORDS = new Set(["in", "at", "by", "is", "as", "an", "or", "if", "it", "be", "we", "us", "my", "so", "up", "no", "do", "go", "he", "me", "am", "via", "per", "with", "from", "into"]);
/** Particles that begin a surname rather than end the given names: a fallback never starts with one, and they may be written in lower case. */
export const NAME_PARTICLES = new Set([...SURNAME_PARTICLES, "los", "las"]);
/** Names made only of these are roles or placeholders, not people. */
const ROLE_WORDS = new Set([
  "premier", "minister", "deputy", "parliamentary", "secretary", "mla", "mp", "assistant", "associate", "acting", "staff", "team",
  "office", "tbd", "tba", "none", "other", "various", "multiple", "ministry", "unknown", "gcpe", "communications", "media",
  "relations", "director", "executive", "chief", "of", "and", "for", "government", "representative", "events", "event",
  "planner", "videographer", "photographer", "coordinator", "admin", "administrator", "system", "test", "user", "hq",
  // Shared lines and inboxes ("Media Line", "News Desk") and the province itself ("BC CEO").
  "line", "desk", "inbox", "hotline", "mailbox", "account", "information", "inquiries", "bc",
  // Outlets listed as media contacts ("Global News", "CHEK Television").
  "news", "radio", "tv", "television", "productions", "studio", "studios", "network", "broadcasting", "newspaper", "magazine",
]);
/**
 * Words that end an office title ("Chief Information Officer", "Board Chair"). A parse whose surname is one of these is
 * an office, not a person. Office words that are also common surnames (Mayor, Speaker, Leader, Elder, General) are left out.
 */
const OFFICE_ENDS = new Set([
  "officer", "secretary", "minister", "ministers", "premier", "chair", "chairperson", "president", "commissioner", "advisor", "adviser",
  "councillor", "councillors", "deputy", "assistant", "associate", "executive", "director", "coordinator", "manager", "governor",
  "lieutenant", "provincial", "regional", "board", "cabinet", "council", "committee", "registrar", "auditor", "comptroller",
  "ombudsperson", "ombudsman", "clerk", "superintendent", "inspector", "chancellor", "ambassador", "consul", "specialist", "strategist",
  "lead", "analyst", "editor", "gallery", "ceo", "cfo", "coo", "cio", "cto", "information",
]);
/** Offices written "Office, Place or Body" ("Mayor, Nelson", "Speaker, Legislative Assembly"). */
const PLACE_OFFICES = new Set(["mayor", "speaker", "leader", "general"]);
/** Role words that stand in for an unknown surname or name a crew job ("Quill TBD", "Quill Videographer"): the given name is still a person's. */
const STAND_INS = new Set(["tbd", "tba", "none", "other", "unknown", "test", "staff", "videographer", "photographer"]);
const isRole = (t: string) => ROLE_WORDS.has(t) || TITLES.has(t) || HONORIFICS.has(t) || LINKS.has(t);
/** What a part after a comma starts with when it describes the person rather than naming them ("…, MLA", "…, Minister of Health", "…, Jr."). */
const isDescriptor = (t: string) => ROLE_WORDS.has(t) || TITLES.has(t) || SUFFIXES.has(t);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A directory tag after a name ("Ashbury, Quill GCPE:EX"): ministry code and staff type. */
const DIRECTORY_TAG = /(?<![\p{L}\p{M}])[\p{L}\p{M}]+:[\p{L}\p{M}]+(?![\p{L}\p{M}])/gu;
const tagWords = (s: string) => new Set([...s.matchAll(DIRECTORY_TAG)].flatMap((m) => m[0].split(":").map(normToken)));

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
  const given = stripSuffixes(stripTitles(tail).rest);
  const named = withoutInitials(given);
  // A one-word office head is the surname only before a single given name ("Elder, Quill"), not before the place or
  // body the office belongs to ("Leader, Official Opposition"). Offices held over a place are always read that way
  // ("Mayor, Nelson"), and the role checks still reject "Premier, Quill".
  const titled = withoutInitials(stripTitles(head).rest);
  const asSurname = head.length === 1 && TITLES.has(head[0]!) && !PLACE_OFFICES.has(head[0]!) && named.length === 1;
  const surname = titled.length === 0 && asSurname ? head : titled;
  return surname.length > 0 && given.length > 0 ? { given: named.length > 0 ? named : given, surname } : null;
}

/** Middle initials are dropped, but a lone initial is kept as the given name ("Q. Ashbury"). */
const initialsAware = (words: string[], f: (w: string[]) => ParsedName | null) => f(withoutInitials(words)) ?? f(words);

/** What a rule positively identified as an office, role or placeholder, as against text that just isn't readable as a name. */
const OFFICE = "office";
type Reading = ParsedName | typeof OFFICE | null;

function parseCandidate(s: string): Reading {
  if (/[\d@]/.test(s)) return null;
  const parts = s.split(",").map(tokensOf).filter((p) => p.length > 0);
  if (parts.length > 0 && parts.flat().every(isRole)) return OFFICE;
  // "The Tyee", "The Province": an outlet or organisation, not "The Honourable …".
  if (parts.length === 1 && parts[0]![0] === "the" && parts[0]!.length >= 2 && !HONORIFICS.has(parts[0]![1]!) && !TITLES.has(parts[0]![1]!)) return OFFICE;
  while (parts.length > 1 && isDescriptor(parts[parts.length - 1]![0]!)) parts.pop();
  if (parts.length === 0) return null;
  let p: ParsedName | null;
  if (parts.length === 1) p = initialsAware(parts[0]!, givenFirst);
  else {
    // A head that held a portfolio ("Minister of Tourism, Arts, …") is an office list, never "Surname, Given".
    const { rest, portfolio } = stripTitles(parts[0]!);
    const head = withoutInitials(rest);
    p = portfolio || (head.length >= 2 && !SURNAME_PARTICLES.has(head[0]!)) ? initialsAware(parts[0]!, givenFirst) : surnameFirst(parts[0]!, parts[1]!);
    // An office alone before the comma, with no surname read from it, is "Office, Place" ("Mayor, Nelson").
    if (!p && rest.length === 0) return OFFICE;
  }
  // A crew word or placeholder after a full name ("Quill Ashbury Videographer") isn't the surname: the name before it is.
  if (p && p.given.length >= 2 && p.surname.length === 1 && STAND_INS.has(p.surname[0]!)) p = { given: p.given.slice(0, -1), surname: p.given.slice(-1) };
  if (!p || p.given.length === 0 || p.surname.length === 0 || p.given.length + p.surname.length > 4) return null;
  if (p.surname.some((t) => t.length < 2)) return null;
  const all = [...p.given, ...p.surname];
  if (p.surname.some((t) => OFFICE_ENDS.has(t) || (ROLE_WORDS.has(t) && !STAND_INS.has(t) && !LINKS.has(t))) || all.every(isRole)) return OFFICE;
  // Link words tie an office to its portfolio, so a parse holding one is an office, except where a name carries one:
  // a directory tag ("Ashbury, Quill FOR:EX"), "and" after a given name ("Quill and Bryn Ashbury"), or the surname
  // of a plain two-word name ("Kevin To").
  const tags = tagWords(s);
  const linkedSurname = p.given.length === 1 && p.surname.length === 1 && !isRole(p.given[0]!);
  if (p.given.some((t, k) => LINKS.has(t) && !tags.has(t) && !(t === "and" && k > 0))) return OFFICE;
  if (p.surname.some((t) => LINKS.has(t) && !tags.has(t)) && !linkedSurname) return OFFICE;
  return p;
}

/**
 * A person's name as given names and surname, or null for roles, placeholders and anything that isn't a name.
 * Offices and honorifics in front, suffixes and descriptions after a comma, and a parenthesised note are not
 * part of the name; when the text outside the brackets isn't a name, the text inside them is tried.
 */
export function parseName(raw: string | null): ParsedName | null {
  const r = readName(raw);
  return r === OFFICE ? null : r;
}

/**
 * A stored name without what crowds it: a bracketed note ("[mailto:…]"), an email address and a trailing number
 * ("Quill Ashbury 2"). The parser and the literal route both start from this.
 */
export function cleanName(raw: string): string {
  return raw.replace(/\[[^\]]*\]?/g, " ").replace(/(?:mailto:)?[^\s@,;()[\]<>]+@[^\s@,;()[\]<>]+/gi, " ").replace(/(?:\s+\d+)+\s*$/, "").replace(/\s+/g, " ").trim();
}

function readName(raw: string | null): Reading {
  if (raw === null) return null;
  const s = cleanName(raw);
  if (s === "") return null;
  const outside = s.replace(/\([^()]*\)/g, " ");
  const inside = [...s.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!);
  // "Quill Ashbury - CBC News": the part before a spaced dash is tried after the whole, like a bracketed note.
  const beforeDash = outside.split(/\s[-–—]\s/)[0]!;
  const readings = [outside, ...inside, ...(beforeDash !== outside ? [beforeDash] : [])].map(parseCandidate);
  const p = readings.find((x) => x !== null && x !== OFFICE);
  if (p) return p;
  // A directory tag ("Ashbury, Quill Bryn GCPE:EX") can push a name past four words; then the name is read without it.
  const untagged = outside.replace(DIRECTORY_TAG, " ");
  const t = untagged !== outside ? parseCandidate(untagged) : null;
  if (t !== null && t !== OFFICE) return t;
  return readings[0] === OFFICE ? OFFICE : null;
}

/**
 * True when a stored name is, by the rules above, an office, role or placeholder rather than a person: "Chief Information
 * Officer", "Media Relations", "News Staff", "Arts and Culture". A name that is merely unreadable ("Hon. Okonkwo-Bell",
 * six words) is not one, so the literal route still searches for it.
 */
export function isPlaceholderOrTitle(raw: string | null): boolean {
  const r = readName(raw);
  return r === OFFICE || (r !== null && nameVariants(raw).length === 0);
}

export interface NameVariant { key: string; surnameFirst: boolean; fallback?: true }

/**
 * The forms a name is matched in. With more than one given word, the last given word plus the surname is a fallback:
 * it catches a name behind an office the role lists don't know ("Grand Poobah Quill Ashbury"), and gives way to any
 * other person's own variant.
 */
export function nameVariants(raw: string | null): NameVariant[] {
  const p = parseName(raw);
  // A stand-in surname ("News Staff") or a given part ending in "and" ("Arts and Culture") is kept as a row but
  // gives no forms to match, since its words are ordinary ones.
  if (!p || p.surname.some((t) => STAND_INS.has(t)) || p.given[p.given.length - 1] === "and") return [];
  const first = p.given[0]!;
  const last = p.surname.join(" ");
  const v = new Map<string, boolean>([
    [[...p.given, last].join(" "), false],
    [`${first} ${last}`, false],
    [`${last} , ${p.given.join(" ")}`, true],
    [`${last} , ${first}`, true],
  ]);
  // "Quill and Bryn Ashbury" is matched as "Quill Ashbury" and by the fallback "Bryn Ashbury", never with the "and".
  const paired = p.given.includes("and");
  const out: NameVariant[] = [...v].filter(([key]) => !paired || !key.split(" ").includes("and")).map(([key, surnameFirst]) => ({ key, surnameFirst }));
  const lastGiven = p.given[p.given.length - 1]!;
  const fallback = `${lastGiven} ${last}`;
  // Not from a surname particle ("Quill de la Cruz" gives no "la cruz"), a directory tag ("Ashbury, Quill FOR:EX" gives no
  // "ex ashbury"), a short word ("in"), or an acronym ("Quill CBC Radio" gives no "cbc radio").
  const acronym = [...raw!.matchAll(TOKEN_RE)].some((m) => normToken(m[0]) === lastGiven && m[0].length >= 2 && m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase());
  if (p.given.length > 1 && lastGiven.length > 1 && !isRole(lastGiven) && !NAME_PARTICLES.has(lastGiven) && !FUNCTION_WORDS.has(lastGiven) && !acronym && !tagWords(raw!).has(lastGiven) && !v.has(fallback)) {
    out.push({ key: fallback, surnameFirst: false, fallback: true });
  }
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
  // Every user and crew row is a person, named or not; a row that names another row's person tries that first, below.
  for (const s of sorted) if (!sourceDraft.has(sk(s)) && s.alwaysPerson && !linked(s)) add(draft(`s:${sk(s)}`), s);
  // Rows that name another row's person join that person.
  for (const s of sorted) {
    if (sourceDraft.has(sk(s)) || !linked(s)) continue;
    const target = sourceDraft.get(`${s.linkSource}:${s.linkId}`);
    const c = canonicalOf(s);
    if (target) add(target, s);
    else if (c) add(byCanonical.get(c) ?? draft(`n:${c}`), s);
    else if (s.alwaysPerson) add(draft(`s:${sk(s)}`), s);
  }

  const forbidden = new Set<string>();
  for (const d of drafts.values()) for (const n of d.names) for (const v of nameVariants(n)) if (!v.surnameFirst) forbidden.add(v.key);
  const unplaced = sorted.filter((s) => !sourceDraft.has(sk(s)));
  for (const s of unplaced) for (const n of s.names) if (n && n.trim()) forbidden.add(tokensOf(cleanName(n)).join(" "));
  const allocator = createIdentityAllocator(key, { forbiddenNames: forbidden, reservedEmails });
  const persons: Person[] = [...drafts.values()].sort((a, b) => cmp(a.key, b.key)).map((d) => ({
    key: d.key, names: [...d.names].sort(cmp), emails: [...d.emails].sort(cmp), phones: [...d.phones].sort(cmp), sources: [...d.sources].sort(cmp), fake: allocator.allocate(d.key),
  }));

  // Allocated after every person, so a stray never takes a person's identity.
  const strays: Stray[] = unplaced.map((s) => ({ ...s, fake: allocator.allocate(`x:${sk(s)}`) }));
  const index: PeopleIndex = { persons, bySource: new Map(), byVariant: new Map(), byEmail: new Map(), firstTokens: new Set(), maxWords: 0, strays };
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
  const rows = [
    ...index.persons.map((p) => [p.key, p.names.join(" | "), p.emails.join(" | "), p.fake.full, p.fake.email, p.fake.phone]),
    ...index.strays.map((s) => [`x:${s.source}:${s.id}`, s.names.filter((n): n is string => !!n && n.trim() !== "").join(" | "), s.email ?? "", s.fake.full, s.fake.email, s.fake.phone]),
  ].map((r) => r.map(csvCell).join(","));
  return ["person_key,real_names,real_emails,fake_name,fake_email,fake_phone", ...rows].join("\n") + "\n";
}
