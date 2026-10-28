import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { bcSettings } from "../test/fixtures";
import { expectAccessibleStructure, withoutChromeScripts } from "../test/structure";
import { SUBSCRIBE_PAGES, writeSubscribePages } from "./subscribe-pages";

const site = { name: "BC Gov News", baseUrl: "https://boxs.ca/site" };

describe("subscribe test pages", () => {
  it("writes the three pages with site chrome, noindex on a test site, and no innerHTML", async () => {
    const files = new Map<string, string>();
    await writeSubscribePages({ write: async (p: string, c: string) => void files.set(p, c) } as never, site, { test: true });
    expect([...files.keys()].sort()).toEqual(["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"]);
    for (const html of files.values()) {
      expect(html).toContain('<a class="navbar-brand ps-3" href="/site/">');
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).toContain("/api/Subscribe/");
      expect(html).toContain("api-version=1.0");
      expect(html).not.toContain("innerHTML");
    }
  });
  it("is accessible page structure, same chrome as every other page", () => {
    for (const page of SUBSCRIBE_PAGES) expectAccessibleStructure(page.render(site, {}));
  });
  it("the unsubscribe page only acts on a button press", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/unsubscribe/index.html")!.render(site, {});
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/);
  });
  it("offers the emergency category alongside ministries, sectors, themes and tags", () => {
    for (const path of ["subscribe/index.html", "subscribe/manage/index.html"]) {
      const html = SUBSCRIBE_PAGES.find((p) => p.path === path)!.render(site, {});
      expect(html).toContain('<fieldset data-category="emergency">');
    }
  });
  it("has two fixed live regions instead of switching one element's role", () => {
    for (const page of SUBSCRIBE_PAGES) {
      const html = page.render(site, {});
      expect(html).toContain('<p id="message" role="status"></p>');
      expect(html).toContain('<p id="message-alert" role="alert"></p>');
      expect(withoutChromeScripts(html)).not.toContain("setAttribute(\"role\"");
    }
  });
  it("the manage page shows the request box immediately and never queries Confirm when there is no token", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/manage/index.html")!.render(site, {});
    expect(html).toMatch(/if\s*\(!token\)\s*\{\s*requestForm\.hidden = false;\s*\}\s*else\s*\{/);
  });
  it("pins the expired-link wording", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/manage/index.html")!.render(site, {});
    expect(html).toContain("This link has expired. Request a new one below.");
  });
});

const render = (path: string, opts = {}) => SUBSCRIBE_PAGES.find((p) => p.path === path)!.render(site, opts);
const subscribeDoc = (opts = {}) => new JSDOM(render("subscribe/index.html", opts)).window.document;

describe("news.gov subscribe page", () => {
  it("one h1; manage link with base path; details#newsOnDemand open; notice heading and body from settings", () => {
    const settings = bcSettings();
    settings.pageText.collectionNotice = { heading: "Collection <Notice>", bodyHtml: "<p>We collect <i>this</i>.</p>" };
    settings.pageText.subscribeHelpHtml = "<p>Help me</p>";
    const doc = subscribeDoc({ settings });
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const body = doc.querySelector("div.connect.subscribe.mb-3 > div.home-body#main-content-release")!;
    expect(body.querySelector("h1")!.textContent).toBe("Subscribe");
    expect(body.querySelector('a[href="/site/subscribe/manage/"]')!.textContent).toBe("manage your account or unsubscribe");
    const details = body.querySelector("form#subscribe-form details.expandable-section#newsOnDemand")!;
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.querySelector("summary > h2")!.textContent).toBe("BC Gov News On Demand");
    expect(details.textContent).toContain("As soon as it's published.");
    expect(details.textContent).toContain("In a daily digest after 5 p.m.");
    const legend = details.querySelector("fieldset > legend")!;
    expect(legend.textContent).toBe("Let us know what areas of the B.C. government you're interested in.");
    const radios = [...details.querySelectorAll('input[type="radio"][name="isAllNews"]')];
    expect(radios.map((r) => r.closest("label")!.textContent!.trim())).toEqual(["I would like to receive news from all ministries and sectors.", "I would like to customize the news that I receive."]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    const custom = details.querySelector("div#newsOnDemandCustomOptions")!;
    expect(custom.hasAttribute("hidden")).toBe(true);
    expect(custom.querySelectorAll("fieldset[data-category]")).toHaveLength(5);
    const notice = body.querySelector("div#noticeOfCollection")!;
    expect(notice.querySelector("p > b")!.textContent).toBe("Collection <Notice>");
    expect(notice.innerHTML).toContain("Collection &lt;Notice&gt;");
    expect(notice.innerHTML).toContain("<i>this</i>");
    expect(body.querySelector("label[for=email]")!.textContent).toBe("What email address would you like to use for notifications?");
    expect(body.querySelector("input#email")).not.toBeNull();
    expect(body.querySelector("button#save.btn")!.textContent).toBe("Subscribe");
    expect(body.innerHTML).toContain("Help me");
    expect(body.querySelector("#message")!.getAttribute("role")).toBe("status");
    expect(body.querySelector("#message-alert")!.getAttribute("role")).toBe("alert");
    // The form contract's names are unchanged.
    expect(body.querySelector('input[name="emailAddress"]')).not.toBeNull();
    expect(body.querySelector('input[name="isAsItHappens"]')).not.toBeNull();
    expect(body.querySelector('input[name="isDailyDigest"]')).not.toBeNull();
  });

  it("notice bodyHtml and help with <script> or onclick render without them", () => {
    const settings = bcSettings();
    settings.pageText.collectionNotice.bodyHtml = '<p onclick="x()">Hi</p><script>alert(1)</script><img src="https://x.test/a.png" alt="a">';
    settings.pageText.subscribeHelpHtml = '<p><a href="javascript:alert(1)" onmouseover="y()">help</a></p><script>alert(2)</script>';
    const doc = subscribeDoc({ settings });
    const html = doc.querySelector("#noticeOfCollection")!.outerHTML + doc.querySelector("#main-content-release")!.innerHTML;
    expect(html).toContain("Hi");
    expect(html).not.toMatch(/onclick|onmouseover|alert\(|javascript:/i);
    expect(doc.querySelector("#noticeOfCollection img")).toBeNull();
    expect(doc.querySelector("#noticeOfCollection script")).toBeNull();
  });

  it("the manage page: connect > home-body > h1 Manage Subscription, rest unchanged", () => {
    const doc = new JSDOM(render("subscribe/manage/index.html")).window.document;
    expect(doc.querySelector("div.connect.subscribe > div.home-body > h1")!.textContent).toBe("Manage Subscription");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("form#manage-form")).not.toBeNull();
    expect(doc.querySelector("input#manage-email")).not.toBeNull();
  });

  /** Runs the page's own script against stubbed API lists. */
  async function run(search: string, items: Record<string, { key: string; value: string }[]>, failing: string[] = []) {
    const html = render("subscribe/index.html", { settings: bcSettings() });
    const dom = new JSDOM(html, { url: `https://boxs.example/site/subscribe/${search}`, runScripts: "outside-only" });
    const w = dom.window as unknown as { fetch: unknown; eval(s: string): void };
    const posted: unknown[] = [];
    w.fetch = async (url: string, init?: { body?: string }) => {
      if (init?.body) {
        posted.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      const cat = decodeURIComponent(String(url).split("SubscriptionItems/")[1]!.split("?")[0]!);
      if (failing.includes(cat)) return cat === "sectors" ? new Response("oops", { status: 503 }) : Promise.reject(new TypeError("network"));
      return new Response(JSON.stringify(items[cat] ?? []), { status: 200 });
    };
    const script = [...dom.window.document.querySelectorAll("script")].map((s) => s.textContent!).find((t) => t.includes("/api/Subscribe/"))!;
    w.eval(script);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return { doc: dom.window.document, posted, win: dom.window };
  }
  const ITEMS = {
    ministries: [{ key: "health", value: "Health" }, { key: "finance", value: "Finance" }, { key: "forests", value: "Forests" }],
    sectors: [{ key: "economy", value: "Economy" }, { key: "services", value: "Services" }],
    tags: [{ key: "cleanbc", value: "CleanBC" }],
    themes: [{ key: "x", value: "X" }],
    emergency: [],
  };
  const checkedNames = (doc: Document) => [...doc.querySelectorAll<HTMLInputElement>("fieldset[data-category] input:checked")].map((i) => i.name).sort();

  it("?ministries=health&ministries=finance&sectors=economy,services checks those boxes and selects customize", async () => {
    const { doc } = await run("?ministries=health&ministries=Finance&sectors=economy,services&newsletters=all&tags=nope", ITEMS);
    expect(checkedNames(doc)).toEqual(["ministries:finance", "ministries:health", "sectors:economy", "sectors:services"]);
    expect(doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="false"]')!.checked).toBe(true);
    expect(doc.getElementById("newsOnDemandCustomOptions")!.hasAttribute("hidden")).toBe(false);
  });

  it("topics is an alias for tags; themes and emergency prefill too; unknown values are ignored and the page stays on all", async () => {
    const a = await run("?topics=cleanbc&themes=x", { ...ITEMS, emergency: [{ key: "wildfire", value: "Wildfire" }] });
    expect(checkedNames(a.doc)).toEqual(["tags:cleanbc", "themes:x"]);
    const b = await run("?emergency=WILDFIRE", { ...ITEMS, emergency: [{ key: "wildfire", value: "Wildfire" }] });
    expect(checkedNames(b.doc)).toEqual(["emergency:wildfire"]);
    const c = await run("?ministries=%3Cimg%20src=x%3E,zzz", ITEMS);
    expect(checkedNames(c.doc)).toEqual([]);
    expect(c.doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="true"]')!.checked).toBe(true);
    expect(c.doc.getElementById("newsOnDemandCustomOptions")!.hasAttribute("hidden")).toBe(true);
    expect(c.doc.querySelector("#main-content-release img")).toBeNull();
  });

  it("an empty emergency list removes its fieldset", async () => {
    const { doc } = await run("", ITEMS);
    expect(doc.querySelector('fieldset[data-category="emergency"]')).toBeNull();
    expect(doc.querySelector('fieldset[data-category="ministries"]')).not.toBeNull();
  });

  it("choosing customize shows the options (focus stays on the radio); all hides them again; the post keeps its shape", async () => {
    const { doc, posted, win } = await run("", ITEMS);
    const custom = doc.getElementById("newsOnDemandCustomOptions")!;
    const customize = doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="false"]')!;
    customize.focus();
    customize.checked = true;
    customize.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(custom.hasAttribute("hidden")).toBe(false);
    expect(doc.activeElement).toBe(customize);
    doc.querySelector<HTMLInputElement>('input[name="ministries:health"]')!.checked = true;
    doc.querySelector<HTMLInputElement>("#email")!.value = "a@b.test";
    doc.getElementById("subscribe-form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([{ emailAddress: "a@b.test", subscribedCategories: { ministries: ["health"] }, isAllNews: false, isAsItHappens: true, isDailyDigest: false }]);
    const all = doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="true"]')!;
    all.checked = true;
    all.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(custom.hasAttribute("hidden")).toBe(true);
  });

  const submit = async (doc: Document, win: Window) => {
    doc.getElementById("subscribe-form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("customize with nothing checked: no POST, the alert says why and focus goes to the customize radio; checking one then posts", async () => {
    const { doc, posted, win } = await run("", ITEMS);
    const customize = doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="false"]')!;
    customize.checked = true;
    customize.dispatchEvent(new win.Event("change", { bubbles: true }));
    doc.querySelector<HTMLInputElement>("#email")!.value = "a@b.test";
    doc.querySelector<HTMLButtonElement>("#save")!.focus();
    await submit(doc, win as unknown as Window);
    expect(posted).toEqual([]);
    expect(doc.getElementById("message-alert")!.getAttribute("role")).toBe("alert");
    expect(doc.getElementById("message-alert")!.textContent).toBe("Choose at least one area, or select all news.");
    expect(doc.activeElement).toBe(customize);
    doc.querySelector<HTMLInputElement>('input[name="sectors:economy"]')!.checked = true;
    await submit(doc, win as unknown as Window);
    expect(posted).toEqual([{ emailAddress: "a@b.test", subscribedCategories: { sectors: ["economy"] }, isAllNews: false, isAsItHappens: true, isDailyDigest: false }]);
    expect(doc.getElementById("message-alert")!.textContent).toBe("");
  });

  it("all news with nothing checked still posts (the check is only for customize)", async () => {
    const { doc, posted, win } = await run("", ITEMS);
    doc.querySelector<HTMLInputElement>("#email")!.value = "a@b.test";
    await submit(doc, win as unknown as Window);
    expect(posted).toEqual([{ emailAddress: "a@b.test", subscribedCategories: {}, isAllNews: true, isAsItHappens: true, isDailyDigest: false }]);
  });

  it("a prefill link whose lists fail to load stays on customize with Subscribe disabled and says why (never silently all news)", async () => {
    for (const failing of [["ministries"], ["sectors"]]) {
      const { doc, posted, win } = await run("?ministries=health", ITEMS, failing);
      expect(doc.querySelector<HTMLInputElement>('input[name="isAllNews"][value="false"]')!.checked).toBe(true);
      expect(doc.getElementById("newsOnDemandCustomOptions")!.hasAttribute("hidden")).toBe(false);
      const save = doc.querySelector<HTMLButtonElement>("#save")!;
      expect(save.disabled).toBe(true);
      expect(doc.getElementById("message-alert")!.textContent).toBe("Couldn't load the topics your link chose, so you can't subscribe to them yet. Reload the page to try again.");
      doc.querySelector<HTMLInputElement>("#email")!.value = "a@b.test";
      await submit(doc, win as unknown as Window);
      expect(posted).toEqual([]);
    }
  });

  it("without a prefill a failed list only warns: all news stays selected and Subscribe works", async () => {
    const { doc, posted, win } = await run("", ITEMS, ["ministries"]);
    expect(doc.getElementById("message-alert")!.textContent).toBe("Couldn't load topics. Reload the page to try again.");
    expect(doc.querySelector<HTMLButtonElement>("#save")!.disabled).toBe(false);
    doc.querySelector<HTMLInputElement>("#email")!.value = "a@b.test";
    await submit(doc, win as unknown as Window);
    expect(posted).toHaveLength(1);
  });
});
