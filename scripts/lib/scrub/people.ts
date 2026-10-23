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

/** A word: letters and marks, with inner apostrophes and hyphens (O'Neil, Tennant-Vey). */
export const TOKEN_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const HONORIFICS = new Set(["hon", "honourable", "honorable", "the", "rt", "dr", "mr", "mrs", "ms", "mx", "sir", "dame"]);
/** Names made only of these are roles or placeholders, not people. */
const ROLE_WORDS = new Set([
  "premier", "minister", "deputy", "parliamentary", "secretary", "mla", "mp", "assistant", "associate", "acting", "staff", "team",
  "office", "tbd", "tba", "none", "other", "various", "multiple", "ministry", "unknown", "gcpe", "communications", "media",
  "relations", "director", "executive", "chief", "of", "and", "for", "government", "representative", "events", "event",
  "planner", "videographer", "photographer", "coordinator", "admin", "administrator", "system", "test", "user", "hq",
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normToken(t: string): string {
  return t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/’/g, "'");
}

export function normEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

const tokensOf = (raw: string) => [...raw.matchAll(TOKEN_RE)].map((m) => normToken(m[0])).filter((t) => t.length > 1);

/** A person's name as given names and surname, or null for roles, placeholders and anything that isn't a name. */
export function parseName(raw: string | null): { given: string[]; surname: string[] } | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "" || /[\d@]/.test(s)) return null;
  const parts = s.split(",");
  let given: string[];
  let surname: string[];
  if (parts.length === 2) {
    surname = tokensOf(parts[0]!);
    given = tokensOf(parts[1]!);
  } else if (parts.length === 1) {
    const t = tokensOf(s);
    surname = t.slice(-1);
    given = t.slice(0, -1);
  } else return null;
  while (given.length > 0 && HONORIFICS.has(given[0]!)) given.shift();
  if (given.length === 0 || surname.length === 0 || given.length + surname.length > 4) return null;
  if ([...given, ...surname].every((t) => ROLE_WORDS.has(t))) return null;
  return { given, surname };
}

export function nameVariants(raw: string | null): { key: string; surnameFirst: boolean }[] {
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
  return [...v].map(([key, surnameFirst]) => ({ key, surnameFirst }));
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
  for (const p of persons) {
    for (const n of p.names) for (const v of nameVariants(n)) if (!index.byVariant.has(v.key)) index.byVariant.set(v.key, { person: p, surnameFirst: v.surnameFirst });
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
