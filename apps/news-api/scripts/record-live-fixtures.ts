// Records public, read-only GET responses from the live BC Gov News API (1 request/second).
// Slide `image` fields are truncated to 400 base64 chars to keep fixtures small (still valid base64).
// Personal contact details (ministry contactUser/secondContactUser) are replaced with fictional
// placeholders so the committed fixtures contain no staff names, phone numbers or emails.
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_FIXTURE_DIR, type LiveFixture } from "../src/dev/fixtures";

const BASE = process.env.NEWS_API_LIVE_BASE ?? "https://api.news.gov.bc.ca";
const V = "api-version=1.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLACEHOLDER_CONTACT = { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" };

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "image" && typeof v === "string") return [k, v.slice(0, 400)];
        if ((k === "contactUser" || k === "secondContactUser") && v) return [k, PLACEHOLDER_CONTACT];
        return [k, sanitize(v)];
      }),
    );
  }
  return value;
}

async function record(name: string, path: string): Promise<LiveFixture> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = sanitize(JSON.parse(text));
    } catch {
      body = text;
    }
  }
  const fixture: LiveFixture = { name, path, status: res.status, contentType: res.headers.get("content-type"), body };
  writeFileSync(`${DEFAULT_FIXTURE_DIR}${name}.json`, JSON.stringify(fixture, null, 2) + "\n");
  console.log(res.status, name);
  await sleep(1000);
  return fixture;
}

type Keyed = { key: string; reference?: string; topPostKey?: string | null; featurePostKey?: string | null };

mkdirSync(DEFAULT_FIXTURE_DIR, { recursive: true });

const home = (await record("home", `/api/Home?${V}`)).body as Keyed;
await record("home-no-version", `/api/Home`);
await record("home-bad-version", `/api/Home?api-version=2.0`);
const health = (await record("ministry-health", `/api/Ministries/health?${V}`)).body as Keyed;
await record("ministries", `/api/Ministries?${V}`);
await record("minister-health", `/api/Ministries/health/Minister?${V}`);
await record("ministry-unknown", `/api/Ministries/zz-unknown?${V}`);

const featured = [home.topPostKey, home.featurePostKey, health.topPostKey, health.featurePostKey].filter((k): k is string => !!k);
await record("featured-posts", `/api/Posts?postKeys=${featured.join(",")}&${V}`);

const latest = (await record("latest-home", `/api/Posts/Latest/home/default?count=3&${V}`)).body as Keyed[];
const first = latest[0]!;
const second = latest[1]!;
await record("post-first", `/api/Posts/${first.key}?${V}`);
await record("post-first-lowercase", `/api/Posts/${first.key.toLowerCase()}?${V}`);
await record("posts-multi", `/api/Posts?postKeys=${second.key},zz-unknown,${first.key.toLowerCase()}&${V}`);
await record("post-unknown", `/api/Posts/zz-unknown-key?${V}`);
await record("keys-reference", `/api/Posts/Keys/${first.reference!.toLowerCase()}?${V}`);
await record("keys-reference-unknown", `/api/Posts/Keys/NEWS-0?${V}`);
await record("latest-ministry-health", `/api/Posts/Latest/ministries/health?count=4&${V}`); // 4 so Keys(count=4) is always covered together with featured-posts
for (const kind of ["factsheets", "stories", "updates"]) {
  await record(`latest-home-${kind}`, `/api/Posts/Latest/home/default?postKind=${kind}&count=1&${V}`);
}
await record("keys-home", `/api/Posts/Keys/home/default?count=3&${V}`);
await record("keys-home-skip", `/api/Posts/Keys/home/default?count=2&skip=1&${V}`);
await record("keys-home-advisories", `/api/Posts/Keys/home/default?postKind=advisories&count=3&${V}`);
await record("keys-ministry-health-upper", `/api/Posts/Keys/ministries/HEALTH?count=4&${V}`);
await record("keys-theme-unknown", `/api/Posts/Keys/themes/zz-unknown?count=1&${V}`);
await record("keys-unknown-kind", `/api/Posts/Keys/services/zz?count=1&${V}`);
await record("latest-media-video", `/api/Posts/LatestMediaUri/video?${V}`);

for (const [singular, plural] of [["sector", "Sectors"], ["theme", "Themes"], ["tag", "Tags"]] as const) {
  const list = (await record(`${singular}s`, `/api/${plural}?${V}`)).body as Keyed[];
  await record(`${singular}-first`, `/api/${plural}/${list[0]!.key}?${V}`);
  await record(`${singular}-unknown`, `/api/${plural}/zz-unknown?${V}`);
}
const slides = (await record("slides", `/api/Slides?${V}`)).body as Keyed[];
await record("slide-first", `/api/Slides/${slides[0]!.key.toUpperCase()}?${V}`);
await record("slide-unknown", `/api/Slides/00000000-0000-0000-0000-000000000000?${V}`);
await record("resource-links", `/api/ResourceLinks?${V}`);
