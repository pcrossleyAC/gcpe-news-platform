import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { SITE_BANNER_SCRIPT } from "./banner-script";

const START = "2026-11-02T09:00:00-08:00";
const END = "2026-11-03T09:00:00-08:00";
const banner = (over: Record<string, unknown> = {}) => ({
  visible: true,
  style: "info",
  message: "Offices are closed on Remembrance Day.",
  links: [{ text: "Find a service", url: "/services" }],
  dismissible: false,
  startsAt: START,
  endsAt: END,
  ...over,
});

/** A page with the placeholder (and optionally the Blue Bridge banner), the script run against a
 * fixed Date.now and a fake fetch answering `json`. Resolves once the script has finished. */
async function run(json: unknown, now: string, opts: { blueBridge?: boolean; status?: number } = {}) {
  const bb = opts.blueBridge ? `<div class="blue-bridge-banner" role="alert">Blue Bridge</div>` : "";
  const dom = new JSDOM(`<!doctype html><body>${bb}<div id="site-banner" hidden data-base="/site"></div></body>`, { url: "https://boxs.example/site/", runScripts: "outside-only" });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(json), { status: opts.status ?? 200 }));
  dom.window.fetch = fetchMock as unknown as typeof fetch;
  dom.window.Date.now = () => Date.parse(now);
  dom.window.eval(SITE_BANNER_SCRIPT);
  if (!opts.blueBridge) await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
  const el = dom.window.document.getElementById("site-banner")!;
  return { dom, el, fetchMock };
}

describe("site banner script", () => {
  it("fetches the banner JSON under the base path, uncached", async () => {
    const { fetchMock } = await run(banner(), START);
    expect(fetchMock).toHaveBeenCalledWith("/site/assets/site-banner.json", { cache: "no-store" });
  });

  it("renders nothing before startsAt, renders at startsAt, nothing at endsAt", async () => {
    expect((await run(banner(), "2026-11-02T08:59:59-08:00")).el.hidden).toBe(true);
    const at = await run(banner(), START);
    expect(at.el.hidden).toBe(false);
    expect(at.el.textContent).toContain("Offices are closed on Remembrance Day.");
    expect((await run(banner(), END)).el.hidden).toBe(true);
  });

  it("no start or end: shows while visible; visible false shows nothing", async () => {
    expect((await run(banner({ startsAt: null, endsAt: null }), START)).el.hidden).toBe(false);
    expect((await run(banner({ visible: false, startsAt: null, endsAt: null }), START)).el.hidden).toBe(true);
  });

  it("a failed fetch shows nothing", async () => {
    expect((await run(banner(), START, { status: 404 })).el.hidden).toBe(true);
  });

  it("info has no role; emergency gets role=alert and the emergency class", async () => {
    const info = (await run(banner(), START)).el.querySelector(".site-banner")!;
    expect(info.getAttribute("role")).toBeNull();
    expect(info.className).toBe("site-banner site-banner-info");
    const emergency = (await run(banner({ style: "emergency" }), START)).el.querySelector(".site-banner")!;
    expect(emergency.getAttribute("role")).toBe("alert");
    expect(emergency.className).toBe("site-banner site-banner-emergency");
  });

  it("dismissible shows a Close banner button that hides it; otherwise no button", async () => {
    expect((await run(banner(), START)).el.querySelector("button")).toBeNull();
    const { el, dom } = await run(banner({ dismissible: true }), START);
    const button = el.querySelector("button")!;
    expect(button.textContent).toBe("Close banner");
    expect(button.getAttribute("type")).toBe("button");
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(el.hidden).toBe(true);
  });

  it("renders nothing (and fetches nothing) while the Blue Bridge banner is on the page", async () => {
    const { el, fetchMock } = await run(banner(), START, { blueBridge: true });
    expect(el.hidden).toBe(true);
    expect(el.childElementCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inserts the message and links as text; a / link gets the base path; an unsafe URL is text, never an href", async () => {
    const hostile = banner({
      message: '<img src=x onerror="alert(1)"> closed',
      links: [
        { text: "<b>Services</b>", url: "/services" },
        { text: "Gov", url: "https://gov.bc.ca/x" },
        { text: "Bad", url: "javascript:alert(1)" },
        { text: "Off-site", url: "//evil.example" },
        { text: "Backslash", url: "/\\evil.example" },
        { text: "Plain http", url: "http://gov.bc.ca" },
      ],
    });
    const { el } = await run(hostile, START);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("p")?.textContent).toBe('<img src=x onerror="alert(1)"> closed');
    expect([...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["<b>Services</b>", "/site/services"],
      ["Gov", "https://gov.bc.ca/x"],
    ]);
    expect(el.textContent).toContain("Bad");
    expect(el.innerHTML).not.toContain("javascript:");
    expect(el.innerHTML).not.toContain("evil.example");
  });

  it("never uses innerHTML", () => {
    expect(SITE_BANNER_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
