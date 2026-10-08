import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express, { type Router } from "express";

/**
 * A fake emergency alerts feed, shaped like the WordPress category feed legacy's
 * EmergencyInfo.exe read (RSS 2.0 with `content:encoded`). Mounted by the stack on test sites
 * and in e2e, never in production. Every alert is made up; links point at example.test.
 */

export interface FakeAlert {
  guid: string;
  link: string;
  title: string;
  html: string;
  publishedAt: string;
}

export interface FakeEmergencyFeedControls {
  add(input: { title: string; html?: string; guid?: string; link?: string }): FakeAlert;
  reset(): void;
  alerts(): FakeAlert[];
}

export const FAKE_ALERT_HOST = "https://emergency.example.test";

function startingAlerts(): FakeAlert[] {
  return [
    { guid: "fake-alert-seed-1", link: `${FAKE_ALERT_HOST}/alerts/fake-alert-seed-1`, title: "Sample alert: boil water advisory lifted", html: "<p>Sample text for testing only.</p>", publishedAt: "2026-09-01T17:00:00.000Z" },
    { guid: "fake-alert-seed-2", link: `${FAKE_ALERT_HOST}/alerts/fake-alert-seed-2`, title: "Sample alert: road reopened", html: "<p>Sample text for testing only.</p>", publishedAt: "2026-08-15T17:00:00.000Z" },
  ];
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A CDATA section can't contain "]]>", so it is split across two sections. */
const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

/** Newest first, as WordPress serves it. */
export function renderFeedXml(alerts: FakeAlert[]): string {
  const items = [...alerts]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(
      (a) =>
        `<item><title>${escapeXml(a.title)}</title><link>${escapeXml(a.link)}</link>` +
        `<guid isPermaLink="false">${escapeXml(a.guid)}</guid><pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>` +
        `<description>${escapeXml(a.title)}</description><content:encoded>${cdata(a.html)}</content:encoded></item>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>` +
    `<title>Fake Emergency Info BC alerts</title><link>${FAKE_ALERT_HOST}/</link><description>Test feed. Never real alerts.</description>` +
    `${items}</channel></rss>\n`
  );
}

function load(statePath: string | undefined): FakeAlert[] {
  if (!statePath) return startingAlerts();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { alerts?: FakeAlert[] };
    return Array.isArray(parsed.alerts) ? parsed.alerts : startingAlerts();
  } catch {
    return startingAlerts();
  }
}

export function createFakeEmergencyFeed(opts: { statePath?: string } = {}): { router: Router; controls: FakeEmergencyFeedControls } {
  let alerts = load(opts.statePath);
  let counter = alerts.length;
  const save = () => {
    if (!opts.statePath) return;
    mkdirSync(dirname(opts.statePath), { recursive: true });
    writeFileSync(opts.statePath, JSON.stringify({ alerts }));
  };

  const controls: FakeEmergencyFeedControls = {
    add(input) {
      counter += 1;
      const guid = input.guid ?? `fake-alert-${Date.now()}-${counter}`;
      const alert: FakeAlert = {
        guid,
        link: input.link ?? `${FAKE_ALERT_HOST}/alerts/${encodeURIComponent(guid)}`,
        title: input.title,
        html: input.html ?? "<p>Test alert.</p>",
        publishedAt: new Date().toISOString(),
      };
      alerts = [alert, ...alerts];
      save();
      return alert;
    },
    reset() {
      alerts = startingAlerts();
      save();
    },
    alerts: () => [...alerts],
  };

  const router = express.Router();
  router.get("/feed.xml", (_req, res) => {
    res.type("application/rss+xml; charset=utf-8").send(renderFeedXml(alerts));
  });
  router.get("/__fake/alerts", (_req, res) => void res.json(controls.alerts()));
  router.post("/__fake/alerts", express.json({ limit: "100kb" }), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
    const title = str(b.title);
    if (!title || title.length > 500) return void res.status(400).json({ error: "title is required (at most 500 characters)" });
    res.status(201).json(controls.add({ title, html: str(b.html), guid: str(b.guid), link: str(b.link) }));
  });
  router.post("/__fake/reset", (_req, res) => {
    controls.reset();
    res.status(204).end();
  });
  return { router, controls };
}
