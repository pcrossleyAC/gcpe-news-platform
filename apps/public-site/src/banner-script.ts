/**
 * The site banner's inline script, on every page right after its empty placeholder
 * (`<div id="site-banner" hidden data-base="…">`, render.ts), into which it inserts the
 * finished banner (`div.site-banner`, role="alert" for an emergency). It fetches
 * `{base}/assets/site-banner.json` (written with the `static` page, static-pages.ts) uncached and
 * shows the banner only if it is visible *now* on the visitor's clock, so a scheduled banner
 * appears and disappears on time with no page rebuild (spec "Delivery").
 *
 * Nothing from the JSON becomes markup: the message and link texts go in with `textContent`, and
 * a link gets an `href` only when it passes the settings' safe-URL rule (an absolute https URL,
 * or a "/" path on this site, which gets the base path) — an unsafe one stays plain text. Hidden
 * while the Blue Bridge banner is on the page. The close button's dismissal isn't remembered (as
 * on news.gov). No banner without JavaScript.
 *
 * Exported as a string so a test can evaluate it in jsdom against a fixed `Date.now` and a fake
 * `fetch` (banner-script.test.ts). It must never contain the text `</script>`.
 */
export const SITE_BANNER_SCRIPT = String.raw`(() => {
  const el = document.getElementById("site-banner");
  if (!el || document.querySelector(".blue-bridge-banner")) return;
  const base = el.getAttribute("data-base") || "";
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
  fetch(base + "/assets/site-banner.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((b) => {
      if (!b || b.visible !== true || typeof b.message !== "string") return;
      const now = Date.now();
      if (b.startsAt && !(now >= Date.parse(b.startsAt))) return;
      if (b.endsAt && !(now < Date.parse(b.endsAt))) return;
      const emergency = b.style === "emergency";
      const box = document.createElement("div");
      box.className = "site-banner site-banner-" + (emergency ? "emergency" : "info");
      if (emergency) box.setAttribute("role", "alert");
      const message = document.createElement("p");
      message.textContent = b.message;
      box.appendChild(message);
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
        box.appendChild(list);
      }
      if (b.dismissible === true) {
        const close = document.createElement("button");
        close.setAttribute("type", "button");
        close.textContent = "Close banner";
        close.addEventListener("click", () => {
          el.hidden = true;
        });
        box.appendChild(close);
      }
      // Shown first, then the finished banner inserted: an alert added to a visible page is
      // what screen readers announce reliably (not a role switched on an existing element).
      el.hidden = false;
      el.appendChild(box);
    })
    .catch(() => {});
})();`;
