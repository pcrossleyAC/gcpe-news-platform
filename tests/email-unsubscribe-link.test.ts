// N1 (CASL): the Unsubscribe link in a subscriber email's body must work when a person clicks it.
// A click is a GET, and the one-click API only takes the RFC 8058 POST mail clients send for the
// List-Unsubscribe header, so the body link has to open the public Unsubscribe page instead.
//
// This follows the link end to end: NoD's real send path builds the request for each kind of
// subscriber email, Distribution's own substitute() fills in the links, the body's link is opened
// as a browser would (a GET of the public Unsubscribe page, running the page's own script), and
// pressing its button goes through the real News API proxy to NoD's real Subscribe API and
// database. The List-Unsubscribe header's one-click POST is checked through the same path.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { JSDOM } from "jsdom";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { substitute } from "../apps/distribution/src/substitute";
import { subscribeRoutes } from "../apps/news-api/src/http/v1/subscribe";
import { createApp } from "../apps/nod/src/app";
import { items, jobRecipients, sendJobs, subscribers } from "../apps/nod/src/db/schema";
import type { DistributionClient, MessageRequest } from "../apps/nod/src/distribution-client";
import { renderAsItHappens, renderDigest, renderEmergency, renderMedia, type RenderItem, type RenderOptions } from "../apps/nod/src/render";
import type { RecipientLinkOptions } from "../apps/nod/src/recipient-links";
import { sendDueJobs } from "../apps/nod/src/send-jobs";
import { addSubscriber } from "../apps/nod/src/subscribers";
import type { JourneyDeps } from "../apps/nod/src/subscribe/journeys";
import { createNodTestDb } from "../apps/nod/test/helpers";
import { SUBSCRIBE_PAGES } from "../apps/public-site/src/subscribe-pages";

const SECRET = "k".repeat(32);
const SITE = { name: "BC Gov News", baseUrl: "https://boxs.example/site" };
const RENDER: RenderOptions = { siteUrl: SITE.baseUrl, bannerUrl: null };
// As start.ts builds them by default from PUBLIC_SITE_URL.
const LINKS: RecipientLinkOptions = {
  pageUrl: `${SITE.baseUrl}/subscribe/manage/`,
  subscribeApiUrl: "https://boxs.example/api/Subscribe",
  linkSecret: SECRET,
};
const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nod";

const ITEM: RenderItem = { key: "K-1", title: "Clinics open", summary: "Summary.", url: "https://boxs.example/site/releases/K-1", publishedAt: new Date("2026-10-30T17:00:00Z"), categories: [] };
const KINDS = {
  "as it happens": renderAsItHappens(ITEM, RENDER),
  emergency: renderEmergency(ITEM, RENDER),
  "daily digest": renderDigest([ITEM], RENDER),
  media: renderMedia({ ...ITEM, mediaText: "Full text.", postKind: "News Release" }, RENDER),
};

const listen = (app: express.Express) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = app.listen(0, () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

describe("the Unsubscribe link in a subscriber email", () => {
  let tdb: TestDatabase;
  let nod: { server: Server; url: string };
  let proxy: { server: Server; url: string };

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const svc = await new SignJWT({ roles: ["NoD.SubscribeApi"] })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("svc")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const deps: JourneyDeps = { db: tdb.db, pageUrl: LINKS.pageUrl, linkSecret: SECRET, render: RENDER, distribution: { send: async () => ({ batchId: "b" }) } };
    nod = await listen(createApp({ db: tdb.db, auth: { issuer, audience, keys }, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: RENDER, subscribe: deps }));
    const newsApi = express();
    newsApi.use("/api", subscribeRoutes({ baseUrl: nod.url, getToken: async () => svc, rateLimitPerMinute: 100 }));
    proxy = await listen(newsApi);
  });
  afterAll(async () => {
    proxy?.server.close();
    nod?.server.close();
    await tdb?.drop();
  });

  /** Sends one job of each kind to `email` through NoD's real send path and returns what
   * Distribution would deliver: html, text and headers with the recipient's links filled in. */
  async function delivered(email: string) {
    const { id } = await addSubscriber(tdb.db, { email, lists: "all" });
    const out: Record<string, { html: string; text: string; headers: Record<string, string> }> = {};
    for (const [kind, rendered] of Object.entries(KINDS)) {
      await tdb.db.delete(sendJobs);
      await tdb.db.insert(items).values({ key: `${email}-${kind}`, kind: "release", title: "Clinics open", url: ITEM.url, publishedAt: new Date() }).onConflictDoNothing();
      const [job] = await tdb.db.insert(sendJobs).values({ jobKey: `as_it_happens:${email}-${kind}`, itemKey: `${email}-${kind}`, ...rendered }).returning();
      await tdb.db.insert(jobRecipients).values({ jobId: job!.id, subscriberId: id });
      const sent: MessageRequest[] = [];
      const distribution = { send: vi.fn(async (req: MessageRequest) => (sent.push(req), { batchId: "00000000-0000-4000-8000-000000000001" })) } as unknown as DistributionClient;
      expect(await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER })).toMatchObject({ sent: 1 });
      const req = sent[0]!;
      const values = req.recipients[0]!.substitutions;
      out[kind] = {
        html: substitute(req.html, values, "html"),
        text: substitute(req.text!, values, "text"),
        headers: Object.fromEntries(Object.entries(req.headers!).map(([k, v]) => [k, substitute(v, values, "header")])),
      };
    }
    return { id, out };
  }

  const statusOf = async (id: string) => (await tdb.db.select({ status: subscribers.status }).from(subscribers).where(eq(subscribers.id, id)))[0]!.status;

  /** Opens `href` as a browser would: the public site serves the page written at that path, and
   * the page's script runs, its API calls going to the News API proxy. */
  function openInBrowser(href: string) {
    const url = new URL(href);
    expect(url.origin).toBe(new URL(SITE.baseUrl).origin);
    const relative = url.pathname.slice(new URL(SITE.baseUrl).pathname.length).replace(/^\//, "");
    const page = SUBSCRIBE_PAGES.find((p) => p.path === `${relative}index.html`);
    expect(page, `no public page is served at ${url.pathname}`).toBeDefined();
    const dom = new JSDOM(page!.render(SITE, {}), { url: href, runScripts: "outside-only" });
    const w = dom.window as unknown as { fetch: unknown; eval(s: string): void };
    const calls: string[] = [];
    w.fetch = (input: string, init?: RequestInit) => {
      const target = new URL(input);
      calls.push(target.pathname);
      return fetch(`${proxy.url}${target.pathname}${target.search}`, init);
    };
    const script = [...dom.window.document.querySelectorAll("script")].map((s) => s.textContent!).find((t) => t.includes("/api/Subscribe/"))!;
    w.eval(script);
    return { doc: dom.window.document, calls };
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("every kind of subscriber email links the same Unsubscribe page in its html and its text", async () => {
    const { out } = await delivered("every-kind@example.test");
    for (const [kind, mail] of Object.entries(out)) {
      const links = [...new JSDOM(mail.html).window.document.querySelectorAll("a")].filter((a) => a.textContent === "Unsubscribe");
      expect(links, kind).toHaveLength(1);
      const href = links[0]!.getAttribute("href")!;
      expect(href, kind).toMatch(/^https:\/\/boxs\.example\/site\/subscribe\/unsubscribe\/\?token=/);
      expect(mail.text, kind).toContain(`Unsubscribe: ${href}`);
      // The header keeps the RFC 8058 one-click POST URL, with the same token.
      expect(mail.headers["List-Unsubscribe"], kind).toBe(`<https://boxs.example/api/Subscribe/OneClickUnsubscribe/${encodeURIComponent(new URL(href).searchParams.get("token")!)}>`);
      expect(mail.headers["List-Unsubscribe-Post"], kind).toBe("List-Unsubscribe=One-Click");
    }
  });

  it("opening the link changes nothing; pressing Unsubscribe on the page unsubscribes them and says so", async () => {
    const { id, out } = await delivered("clicker@example.test");
    const href = [...new JSDOM(out["as it happens"]!.html).window.document.querySelectorAll("a")].find((a) => a.textContent === "Unsubscribe")!.getAttribute("href")!;

    const { doc, calls } = openInBrowser(href);
    await new Promise((r) => setTimeout(r, 50));
    // A mail scanner opening the link must not unsubscribe anyone.
    expect(calls).toEqual([]);
    expect(await statusOf(id)).toBe("active");

    (doc.getElementById("confirm-unsubscribe") as HTMLButtonElement).click();
    await until(() => !!doc.getElementById("message")!.textContent || !!doc.getElementById("message-alert")!.textContent);
    expect(doc.getElementById("message-alert")!.textContent).toBe("");
    expect(doc.getElementById("message")!.textContent).toBe("You're unsubscribed. You won't get any more email from BC Gov News On Demand.");
    expect(calls).toHaveLength(1);
    expect(await statusOf(id)).toBe("deleted");
  });

  it("the plain-text link works the same way", async () => {
    const { id, out } = await delivered("text-reader@example.test");
    const href = out["daily digest"]!.text.match(/^Unsubscribe: (\S+)$/m)![1]!;
    const { doc } = openInBrowser(href);
    (doc.getElementById("confirm-unsubscribe") as HTMLButtonElement).click();
    await until(() => !!doc.getElementById("message")!.textContent || !!doc.getElementById("message-alert")!.textContent);
    expect(doc.getElementById("message")!.textContent).toBe("You're unsubscribed. You won't get any more email from BC Gov News On Demand.");
    expect(await statusOf(id)).toBe("deleted");
  });

  it("the List-Unsubscribe header's one-click POST still unsubscribes", async () => {
    const { id, out } = await delivered("one-click@example.test");
    const oneClick = out.media!.headers["List-Unsubscribe"]!.slice(1, -1);
    const res = await fetch(`${proxy.url}${new URL(oneClick).pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("deleted");
  });
});
