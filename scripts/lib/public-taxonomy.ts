// Pure(ish) fetching + mapping logic for scripts/seed-core-from-public-api.ts, split out so it's
// independently unit-testable with a mocked fetch (see tests/seed-core-from-public-api.test.ts).
//
// Source: the public, read-only BC Gov News API (https://api.news.gov.bc.ca, `?api-version=1.0`).
// Its JSON shapes are produced by apps/news-api/src/dto.ts's toMinistryDto / toMinisterDto /
// toCategoryDto — the functions here invert that projection to rebuild Core's orgInputSchema /
// termInputSchema bodies (apps/core/src/services/organizations.ts, .../terms.ts).
import type { TermKind } from "@gcpe/events";
import { isHqAbbreviation, type OrgInput } from "../../apps/core/src/services/organizations";
import type { TermInput } from "../../apps/core/src/services/terms";

export const DEFAULT_PUBLIC_API_BASE = "https://api.news.gov.bc.ca";

/** Thrown when a public API GET returns a non-2xx status. */
export class PublicApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`GET ${path} failed with status ${status}`);
  }
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** GETs `<baseUrl><path>?api-version=1.0` and parses the JSON body. Only ever GET — this module
 * never mutates the public API. */
export async function getPublicJson<T>(baseUrl: string, path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const url = new URL(path, baseUrl);
  url.searchParams.set("api-version", "1.0");
  const res = await fetchImpl(url, { method: "GET" });
  if (!res.ok) throw new PublicApiError(path, res.status);
  return (await res.json()) as T;
}

// --- Raw public API shapes (swagger: docs/contracts/news-api-v1.swagger.json) ----------------

export interface PublicResourceLink {
  uri?: string | null;
  key?: string | null;
}

export interface PublicContact {
  fullName?: string | null;
  phoneNumber?: string | null;
  mobileNumber?: string | null;
  emailAddress?: string | null;
}

/** #/definitions/Ministry, as projected by apps/news-api/src/dto.ts's toMinistryDto. Note there
 * is no `abbreviation` field anywhere in the public contract or in that projection. */
export interface PublicMinistry {
  key: string;
  name?: string | null;
  parentMinistryKey?: string | null;
  ministryUrl?: string | null;
  displayAdditionalName?: string | null;
  topicLinks?: PublicResourceLink[] | null;
  serviceLinks?: PublicResourceLink[] | null;
  contactUser?: PublicContact | null;
  secondContactUser?: PublicContact | null;
  weekendContactNumber?: string | null;
  twitterFeedUsername?: string | null;
  flickrUri?: string | null;
  youtubeUri?: string | null;
  audioUri?: string | null;
  isActive?: boolean | null;
}

/** #/definitions/Minister, as projected by toMinisterDto. `emailHtml` is a rendered
 * `<a href="mailto: ...">...</a>` fragment (see ministerEmailHtml in dto.ts), not a raw address. */
export interface PublicMinister {
  headline?: string | null;
  summary?: string | null;
  details?: string | null;
  emailHtml?: string | null;
  photo?: string | null;
  post?: string | null;
}

/** Shared shape of #/definitions/Sector, Theme and Tag, as projected by toCategoryDto. */
export interface PublicCategory {
  key: string;
  name?: string | null;
  isActive?: boolean | null;
  twitterFeedUsername?: string | null;
  flickrUri?: string | null;
  youtubeUri?: string | null;
  audioUri?: string | null;
}

/** The slice of #/definitions/Post (toPostDto) needed to derive a ministry's abbreviation. The
 * legacy `key` (e.g. "2026HLTH0012-000345") carries the ministry abbreviation — see
 * apps/nrms/src/releases/record.test.ts's `key: "2026HLTH0001-000001"` and
 * apps/nrms/src/taxonomy.ts's `abbreviation` field, which NRMS requires non-null before
 * approving a release (apps/nrms/src/releases/workflow.ts). `reference` (e.g. "NEWS-00001") is a
 * different, unrelated legacy id and is not used here. */
export interface PublicPost {
  key?: string | null;
  kind?: string | null;
  leadMinistryKey?: string | null;
}

// --- Fetchers (sequential GETs; caller is responsible for the polite delay between calls) ----

export function fetchMinistries(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PublicMinistry[]> {
  return getPublicJson<PublicMinistry[]>(baseUrl, "/api/Ministries", fetchImpl);
}

/** Returns null when the ministry has no minister page (404) — a missing minister shouldn't
 * abort seeding the rest of the ministry's fields. */
export async function fetchMinister(baseUrl: string, ministryKey: string, fetchImpl: typeof fetch = fetch): Promise<PublicMinister | null> {
  try {
    return await getPublicJson<PublicMinister>(baseUrl, `/api/Ministries/${encodeURIComponent(ministryKey)}/Minister`, fetchImpl);
  } catch (e) {
    if (e instanceof PublicApiError && e.status === 404) return null;
    throw e;
  }
}

export function fetchSectors(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PublicCategory[]> {
  return getPublicJson<PublicCategory[]>(baseUrl, "/api/Sectors", fetchImpl);
}

export function fetchThemes(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PublicCategory[]> {
  return getPublicJson<PublicCategory[]>(baseUrl, "/api/Themes", fetchImpl);
}

export function fetchTags(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PublicCategory[]> {
  return getPublicJson<PublicCategory[]>(baseUrl, "/api/Tags", fetchImpl);
}

/** Default number of recent releases to sample when deriving a ministry's abbreviation. */
export const DEFAULT_ABBREVIATION_SAMPLE_SIZE = 20;

/** `GET /api/Posts/Latest/ministries/{key}?postKind=releases&count=...` — the swagger contract's
 * per-category latest-posts endpoint, scoped to `indexKind=ministries`. Requesting
 * `postKind=releases` server-side is a courtesy filter only; `deriveMinistryAbbreviation` below
 * re-checks `kind === "releases"` itself rather than trusting the server to have applied it. */
export function fetchLatestMinistryPosts(baseUrl: string, ministryKey: string, count: number = DEFAULT_ABBREVIATION_SAMPLE_SIZE, fetchImpl: typeof fetch = fetch): Promise<PublicPost[]> {
  const query = new URLSearchParams({ postKind: "releases", count: String(count) });
  return getPublicJson<PublicPost[]>(baseUrl, `/api/Posts/Latest/ministries/${encodeURIComponent(ministryKey)}?${query}`, fetchImpl);
}

// --- Mapping: public DTO -> Core input schema (inverting apps/news-api/src/dto.ts) ------------

/** Inverts dto.ts's `link = (l) => ({ uri: l.url, key: l.text, ... })`. */
function mapLink(l: PublicResourceLink): { text: string; url: string } {
  return { text: l.key ?? "", url: l.uri ?? "" };
}

function mapContact(c: PublicContact | null | undefined): OrgInput["contact"] {
  if (!c) return null;
  return {
    fullName: c.fullName ?? null,
    phoneNumber: c.phoneNumber ?? null,
    mobileNumber: c.mobileNumber ?? null,
    emailAddress: c.emailAddress ?? null,
  };
}

function mapSocial(e: { twitterFeedUsername?: string | null; flickrUri?: string | null; youtubeUri?: string | null; audioUri?: string | null }): OrgInput["social"] {
  return {
    twitterUsername: e.twitterFeedUsername ?? null,
    flickrUrl: e.flickrUri ?? null,
    youtubeUrl: e.youtubeUri ?? null,
    audioUrl: e.audioUri ?? null,
  };
}

/** Inverts dto.ts's `ministerEmailHtml`: null -> null, "" -> "", and the fixed
 * `<a href="mailto: ${email}">${email}</a>` fragment -> the address between the tags. Anything
 * else unrecognized (the public contract gives no other shape) falls back to null rather than
 * guessing. */
export function extractMinisterEmail(emailHtml: string | null | undefined): string | null {
  if (emailHtml === null || emailHtml === undefined) return null;
  if (emailHtml === "") return "";
  const match = /^<a href="mailto:\s*([^"]*)">/.exec(emailHtml);
  return match ? match[1]! : null;
}

/** Legacy release key format, e.g. "2026HLTH0012-000345": 4-digit year, ministry abbreviation
 * (letters), a 4-digit sequence, a dash, then a 6-digit sequence. Group 1 is the abbreviation. */
export const LEGACY_RELEASE_KEY_PATTERN = /^\d{4}([A-Z]+)\d{4}-\d{6}$/;

/** Extracts the ministry abbreviation embedded in one legacy release key, or null if the key
 * doesn't match the legacy format at all. */
export function extractAbbreviationFromReleaseKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const match = LEGACY_RELEASE_KEY_PATTERN.exec(key);
  return match ? match[1]! : null;
}

/**
 * Derives a ministry's abbreviation by majority vote over its recent releases' legacy keys.
 *
 * Only posts of kind "releases" (never stories/factsheets/updates/advisories) whose
 * `leadMinistryKey` matches `ministryKey` (case-insensitively — the public API's own key casing
 * isn't guaranteed to match what was used to request the listing) are considered; everything
 * else is ignored, including posts whose `key` doesn't match the legacy format at all. Returns
 * null, never a guess, when no post yields an abbreviation.
 */
export function deriveMinistryAbbreviation(posts: PublicPost[], ministryKey: string): string | null {
  const wanted = ministryKey.toLowerCase();
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (post.kind !== "releases") continue;
    if ((post.leadMinistryKey ?? "").toLowerCase() !== wanted) continue;
    const abbreviation = extractAbbreviationFromReleaseKey(post.key);
    if (!abbreviation) continue;
    counts.set(abbreviation, (counts.get(abbreviation) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [abbreviation, count] of counts) {
    if (count > bestCount) {
      best = abbreviation;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Builds a Core `orgInputSchema`-shaped body for one ministry.
 *
 * Fields the public API simply doesn't carry get a schema-valid neutral default rather than a
 * guess:
 *  - `abbreviation`: never a direct field in the public contract. The caller derives it from
 *    recent release keys via `deriveMinistryAbbreviation` and passes it in; null when no release
 *    yielded one.
 *  - `sortOrder`: Core-only display ordering, not public -> 0.
 *  - `sectorKeys`: the public Ministry DTO never lists which sectors a ministry belongs to
 *    (that association isn't exposed in either direction) -> [].
 */
export function toOrgInput(ministry: PublicMinistry, minister: PublicMinister | null, abbreviation: string | null = null): OrgInput {
  const key = ministry.key.toLowerCase();
  return {
    key,
    displayName: ministry.name?.trim() || key,
    abbreviation,
    sortOrder: 0,
    isActive: ministry.isActive ?? true,
    parentKey: ministry.parentMinistryKey ? ministry.parentMinistryKey.toLowerCase() : null,
    url: ministry.ministryUrl ?? null,
    displayAdditionalName: ministry.displayAdditionalName ?? null,
    minister: {
      name: minister?.headline ?? null,
      summary: minister?.summary ?? null,
      detailsHtml: minister?.details ?? null,
      email: extractMinisterEmail(minister?.emailHtml),
      photoUrl: minister?.photo ?? null,
      address: minister?.post ?? null,
    },
    contact: mapContact(ministry.contactUser),
    secondContact: mapContact(ministry.secondContactUser),
    weekendContactNumber: ministry.weekendContactNumber ?? null,
    social: mapSocial(ministry),
    topicLinks: (ministry.topicLinks ?? []).map(mapLink),
    serviceLinks: (ministry.serviceLinks ?? []).map(mapLink),
    sectorKeys: [],
  };
}

/**
 * GCPE's two HQ organizations (Calendar spec addendum Q49). The public API lists neither
 * (checked 2026-10-07: 36 ministries, none GCPE), so the seed adds them. The third HQ
 * organization, the Office of the Premier, is a public ministry: the seed marks it rather than
 * adding it (withHqFlag). All three bodies carry isHq only when Core does not hold the organization
 * yet (hqOnlyOnCreate). The Calendar matches all three by abbreviation, as legacy did.
 */
export const HQ_SEED_ORGANIZATIONS: OrgInput[] = [
  hqOrganization("gcpe-headquarters", "GCPE Headquarters", "GCPEHQ"),
  hqOrganization("gcpe-media-relations", "GCPE Media Relations", "GCPEMEDIA"),
];

function hqOrganization(key: string, displayName: string, abbreviation: string): OrgInput {
  return {
    key,
    displayName,
    abbreviation,
    sortOrder: 0,
    isActive: true,
    parentKey: null,
    url: null,
    displayAdditionalName: null,
    minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
    contact: null,
    secondContact: null,
    weekendContactNumber: null,
    social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [],
    serviceLinks: [],
    sectorKeys: [],
    isHq: true,
  };
}

/** Abbreviations the seed knows without a release sample: the Office of the Premier must be marked HQ (Q49) even when its recent releases yield none. */
export const KNOWN_ABBREVIATIONS: Readonly<Record<string, string>> = { "office-of-the-premier": "PREM" };

/** Marks a public ministry HQ when its abbreviation is an HQ one (the Office of the Premier). Every other body omits isHq. */
export function withHqFlag(input: OrgInput): OrgInput {
  return isHqAbbreviation(input.abbreviation) ? { ...input, isHq: true } : input;
}

/**
 * The seed asserts HQ only when it creates the organization (C124). When the organization already
 * exists the body omits isHq, so Core keeps whatever Core.Admin last chose, in either direction.
 */
export function hqOnlyOnCreate(input: OrgInput, exists: boolean): OrgInput {
  if (!exists || input.isHq === undefined) return input;
  const { isHq: _kept, ...body } = input;
  return body;
}

/**
 * Builds a Core `termInputSchema`-shaped body for one sector/theme/tag. `kind` comes from which
 * public endpoint the category was fetched from (Sectors/Themes/Tags), never from the category's
 * own `kind` field — the public DTO's `kind` is the News API's plural internal category kind
 * ("sectors"/"themes"/"tags", see apps/news-api/src/db/schema.ts), not Core's singular
 * `TermKind` ("sector"/"theme"/"tag").
 *
 * `sortOrder` has no public equivalent (Core-only display ordering) -> 0.
 */
export function toTermInput(kind: TermKind, category: PublicCategory): TermInput {
  return {
    kind,
    key: category.key.toLowerCase(),
    displayName: category.name ?? null,
    sortOrder: 0,
    isActive: category.isActive ?? true,
    social: mapSocial(category),
  };
}
