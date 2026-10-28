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
  const bb = opts.blueBridge ? `<div id="bridge-banner" class="info-black-banner container-fluid sm-g-0" role="alert">Blue Bridge</div>` : "";
  const dom = new JSDOM(
    `<!doctype html><body><section id="banner" aria-label="Site notices"${bb ? "" : " hidden"}>${bb}<div id="site-banner" hidden data-base="/site" data-icons="/site/assets/site/icons.svg"></div></section></body>`,
    { url: "https://boxs.example/site/", runScripts: "outside-only" },
  );
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(json), { status: opts.status ?? 200 }));
  dom.window.fetch = fetchMock as unknown as typeof fetch;
  dom.window.Date.now = () => Date.parse(now);
  dom.window.eval(SITE_BANNER_SCRIPT);
  if (!opts.blueBridge) await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
  const el = dom.window.document.getElementById("site-banner")!;
  const section = dom.window.document.getElementById("banner")!;
  return { dom, el, section, fetchMock };
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

  it("builds .info-blue-banner > .content with an info icon, message, links and a close <button> labelled 'Close banner'", async () => {
    const { el, section } = await run(banner({ dismissible: true }), START);
    expect(section.hidden).toBe(false);
    const box = el.firstElementChild!;
    expect(el.childElementCount).toBe(1);
    expect(box.className).toBe("info-blue-banner container-fluid sm-g-0 site-banner-info");
    expect(box.getAttribute("role")).toBeNull();
    const content = box.firstElementChild!;
    expect(box.childElementCount).toBe(1);
    expect(content.className).toBe("content container-xl sm-g-0");
    const [iconDiv, textDiv, closeDiv] = [...content.children];
    expect(content.childElementCount).toBe(3);
    const svg = iconDiv!.querySelector(":scope > svg")!;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("class")).toBe("icon");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-circle-info");
    expect([...textDiv!.children].map((c) => c.tagName)).toEqual(["P", "UL"]);
    expect(textDiv!.querySelector("p")?.textContent).toBe("Offices are closed on Remembrance Day.");
    const a = textDiv!.querySelector("ul > li > a")!;
    expect([a.textContent, a.getAttribute("href"), a.getAttribute("target")]).toEqual(["Find a service", "/site/services", null]);
    const button = closeDiv!.querySelector(":scope > button")!;
    expect(button.id).toBe("btnCloseBanner");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Close banner");
    expect(button.querySelector("svg use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-xmark");
  });

  it("emergency: site-banner-emergency, role=alert, exclamation icon", async () => {
    const box = (await run(banner({ style: "emergency" }), START)).el.firstElementChild!;
    expect(box.className).toBe("info-blue-banner container-fluid sm-g-0 site-banner-emergency");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-circle-exclamation");
  });

  it("no links: no list; not dismissible: no close button", async () => {
    const { el } = await run(banner({ links: [] }), START);
    expect(el.querySelector("ul")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector(".content")!.childElementCount).toBe(2);
  });

  it("the close button hides the whole #banner section and announces nothing new", async () => {
    const { el, section, dom } = await run(banner({ dismissible: true }), START);
    const shown = vi.fn();
    dom.window.document.addEventListener("site-banner-shown", shown);
    el.querySelector<HTMLButtonElement>("#btnCloseBanner")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(section.hidden).toBe(true);
    expect(shown).not.toHaveBeenCalled();
  });

  it("tells the page a banner is shown (site.js reveals the header toggle), and only when it is", async () => {
    const seen: string[] = [];
    const listen = (dom: JSDOM) => dom.window.document.addEventListener("site-banner-shown", () => seen.push("shown"));
    // The event fires after the fetch resolves, so a listener added right after the script ran sees it.
    const dom = new JSDOM(`<!doctype html><body><section id="banner" hidden><div id="site-banner" hidden data-base="" data-icons="/assets/site/icons.svg"></div></section></body>`, { runScripts: "outside-only" });
    dom.window.fetch = (async () => new Response(JSON.stringify(banner({ startsAt: null, endsAt: null })))) as unknown as typeof fetch;
    dom.window.eval(SITE_BANNER_SCRIPT);
    listen(dom);
    await vi.waitFor(() => expect(seen).toEqual(["shown"]));
    const off = new JSDOM(`<!doctype html><body><section id="banner" hidden><div id="site-banner" hidden data-base=""></div></section></body>`, { runScripts: "outside-only" });
    off.window.fetch = (async () => new Response(JSON.stringify(banner({ visible: false })))) as unknown as typeof fetch;
    off.window.eval(SITE_BANNER_SCRIPT);
    let offSeen = 0;
    off.window.document.addEventListener("site-banner-shown", () => offSeen++);
    await new Promise((r) => setTimeout(r, 20));
    expect(offSeen).toBe(0);
    expect(off.window.document.getElementById("banner")!.hidden).toBe(true);
  });

  it("never runs when #bridge-banner is present", async () => {
    const { el, fetchMock } = await run(banner(), START, { blueBridge: true });
    expect(el.hidden).toBe(true);
    expect(el.childElementCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a message with markup stays text", async () => {
    const { el } = await run(banner({ message: "<b>bold</b> & <script>x()</script>", links: [] }), START);
    expect(el.querySelector("b, script")).toBeNull();
    expect(el.querySelector("p")?.textContent).toBe("<b>bold</b> & <script>x()</script>");
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
