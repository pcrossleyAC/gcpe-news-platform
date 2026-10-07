import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createFakeEmergencyFeed, FAKE_ALERT_HOST } from "./index";

function appFor(statePath?: string) {
  const fake = createFakeEmergencyFeed({ statePath });
  const app = express();
  app.use(fake.router);
  return { app, fake };
}

describe("fake emergency feed", () => {
  it("serves an RSS 2.0 feed with two made-up alerts to begin with", async () => {
    const { app } = appFor();
    const res = await request(app).get("/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/rss+xml");
    expect(res.text).toMatch(/^<\?xml/);
    expect(res.text.match(/<item>/g)).toHaveLength(2);
    expect(res.text).toContain(`<link>${FAKE_ALERT_HOST}/alerts/`);
    expect(res.text.trimEnd()).toMatch(/<\/rss>$/);
  });

  it("an added alert is listed first, with its HTML in content:encoded", async () => {
    const { app } = appFor();
    const added = await request(app).post("/__fake/alerts").send({ title: "Evacuation order: Sample Creek", html: "<p>Leave now.</p><p>Route: Highway 1.</p>" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ title: "Evacuation order: Sample Creek", link: expect.stringContaining(FAKE_ALERT_HOST) });
    const feed = (await request(app).get("/feed.xml")).text;
    expect(feed.indexOf("Evacuation order: Sample Creek")).toBeLessThan(feed.indexOf("Sample alert"));
    expect(feed).toContain("<content:encoded><![CDATA[<p>Leave now.</p><p>Route: Highway 1.</p>]]></content:encoded>");
  });

  it("a title is required", async () => {
    const { app } = appFor();
    expect((await request(app).post("/__fake/alerts").send({ html: "<p>x</p>" })).status).toBe(400);
  });

  it("reset goes back to the two starting alerts", async () => {
    const { app, fake } = appFor();
    fake.controls.add({ title: "Extra" });
    expect((await request(app).post("/__fake/reset")).status).toBe(204);
    expect(fake.controls.alerts()).toHaveLength(2);
  });

  it("keeps its alerts across a restart when given a state file", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "fake-feed-")), "state.json");
    appFor(statePath).fake.controls.add({ title: "Survives restart" });
    expect(appFor(statePath).fake.controls.alerts().map((a) => a.title)).toContain("Survives restart");
  });
});
