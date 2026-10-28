/**
 * The site banner's inline script, on every page inside `section#banner` right after its empty
 * placeholder (`<div id="site-banner" hidden data-base="…" data-icons="…">`, render.ts), into which it
 * inserts the finished banner in legacy `_Banner.cshtml`'s skeleton (look-and-feel §1.4):
 * `div.info-blue-banner.container-fluid.sm-g-0.site-banner-{info|emergency}` (role="alert" for an
 * emergency only) > `div.content.container-xl.sm-g-0` > [icon] [`p` message + `ul>li>a` links]
 * [`button#btnCloseBanner` "Close banner", when dismissible]. Its colour comes from the class
 * (overrides.css), never from the JSON. It fetches `{base}/assets/site-banner.json` (written with the
 * `static` page, static-pages.ts) uncached and shows the banner only if it is visible *now* on the
 * visitor's clock, so a scheduled banner appears and disappears on time with no page rebuild (spec
 * "Delivery").
 *
 * Nothing from the JSON becomes markup: the message and link texts go in with `textContent`, and
 * a link gets an `href` only when it passes the settings' safe-URL rule (an absolute https URL,
 * or a "/" path on this site, which gets the base path) — an unsafe one stays plain text. Links
 * open in the same window (look-and-feel §5 #17). Stands down while the Blue Bridge banner
 * (`#bridge-banner`) is on the page. Showing the banner un-hides `#banner` and dispatches
 * `site-banner-shown` on the document, which site.js (site-script.ts) answers by showing the header's
 * banner toggle; the close button hides `#banner`, as legacy did (site.js also listens, to flip the
 * toggle). The dismissal isn't remembered (as on news.gov). No banner without JavaScript.
 *
 * Exported as a string so a test can evaluate it in jsdom against a fixed `Date.now` and a fake
 * `fetch` (banner-script.test.ts). It must never contain the text `</script>`.
 */
export const SITE_BANNER_SCRIPT = String.raw`(() => {
  const el = document.getElementById("site-banner");
  if (!el || document.getElementById("bridge-banner")) return;
  const wrap = document.getElementById("banner");
  const base = el.getAttribute("data-base") || "";
  const sprite = el.getAttribute("data-icons") || "";
  const safeHref = (u) => {
    if (typeof u !== "string" || u === "" || /[\s\u0000-\u001F\u007F]/.test(u)) return null;
    if (u.charAt(0) === "/") return u.charAt(1) === "/" || u.charAt(1) === "\\" ? null : base + u;
    try {
      const url = new URL(u);
      return url.protocol === "https:" && url.hostname ? u : null;
    } catch (e) {
      return null;
    }
  };
  const div = (cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    return d;
  };
  const icon = (id) => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", sprite + "#i-" + id);
    svg.appendChild(use);
    return svg;
  };
  fetch(base + "/assets/site-banner.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((b) => {
      if (!b || b.visible !== true || typeof b.message !== "string") return;
      const now = Date.now();
      if (b.startsAt && !(now >= Date.parse(b.startsAt))) return;
      if (b.endsAt && !(now < Date.parse(b.endsAt))) return;
      const emergency = b.style === "emergency";
      const box = div("info-blue-banner container-fluid sm-g-0 site-banner-" + (emergency ? "emergency" : "info"));
      if (emergency) box.setAttribute("role", "alert");
      const content = div("content container-xl sm-g-0");
      const iconBox = div();
      iconBox.appendChild(icon(emergency ? "circle-exclamation" : "circle-info"));
      content.appendChild(iconBox);
      const text = div();
      const message = document.createElement("p");
      message.textContent = b.message;
      text.appendChild(message);
      const links = Array.isArray(b.links) ? b.links : [];
      if (links.length) {
        const list = document.createElement("ul");
        for (const l of links) {
          if (!l || typeof l.text !== "string") continue;
          const item = document.createElement("li");
          const href = safeHref(l.url);
          if (href) {
            const a = document.createElement("a");
            a.setAttribute("href", href);
            a.textContent = l.text;
            item.appendChild(a);
          } else {
            item.textContent = l.text;
          }
          list.appendChild(item);
        }
        text.appendChild(list);
      }
      content.appendChild(text);
      if (b.dismissible === true) {
        const closeBox = div();
        const close = document.createElement("button");
        close.id = "btnCloseBanner";
        close.setAttribute("type", "button");
        close.setAttribute("aria-label", "Close banner");
        close.appendChild(icon("xmark"));
        close.addEventListener("click", () => {
          (wrap || el).hidden = true;
        });
        closeBox.appendChild(close);
        content.appendChild(closeBox);
      }
      box.appendChild(content);
      // Shown first, then the finished banner inserted: an alert added to a visible page is
      // what screen readers announce reliably (not a role switched on an existing element).
      if (wrap) wrap.hidden = false;
      el.hidden = false;
      el.appendChild(box);
      document.dispatchEvent(new Event("site-banner-shown"));
    })
    .catch(() => {});
})();`;
