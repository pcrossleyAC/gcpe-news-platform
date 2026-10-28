/**
 * `assets/site/site.js` (written by site-assets.ts's writeBuiltinAssets, loaded deferred at the end
 * of every page by render.ts): the header's behaviour, in place of legacy jQuery + Bootstrap JS.
 *
 * 1. `#news-dropdown[data-menu]` (a link to the ministries page) becomes
 *    `<button aria-expanded aria-controls="menu">News {angle-down}</button>`, only when `#menu` exists.
 * 2. Each toggle (`button[aria-controls][aria-expanded]`) flips `aria-expanded`, toggles `.show` on
 *    its target and swaps its icon (bars/angle-down/search ↔ xmark/angle-up/xmark). One panel is
 *    open at a time, as legacy's `data-bs-parent` did — except that News inside the open phone
 *    drawer keeps the drawer open, and closing the drawer closes the menu too.
 * 3. `body.menu-open` while `#menu` is open (overrides.css locks the page's scroll).
 * 4. Escape, with focus on an open panel's button or inside the panel, closes it and returns focus
 *    to its button. So does Escape with focus on nothing (the body): Safari and macOS Firefox don't
 *    focus a clicked button, so a mouse-opened panel would otherwise ignore Escape.
 * 5. The banner toggles (`button[data-banner-toggle]`, header.ts; kept out of 2–4): hidden until a
 *    banner has shown — Blue Bridge's `#bridge-banner` at load, or the site banner's
 *    `site-banner-shown` event (banner-script.ts) — then shown with `aria-expanded` tracking whether
 *    `#banner` is visible. `#btnCloseBanner`/`#btnCloseBannerBridge` hide `#banner` (and collapse
 *    the toggles) and move focus to the visible toggle; a toggle hides or re-shows it. A site banner
 *    closed before this script ran still counts as shown. The dismissal isn't remembered, as on news.gov.
 * 6. The 404 prefill: a form with `data-prefill-from-path` (static-pages.ts's 404 page, served for any
 *    unknown path) gets its empty `#not-found-q` set to `pathWords(location.pathname, base)` — the
 *    missing URL's words — with `.value` only. No script, no prefill: the box is just empty.
 * 7. The search page's phone search control (`a[data-page-search]`, header.ts: a link to the page's
 *    own box) scrolls that box to the middle of the view and focuses it, instead of a jump that
 *    would leave it under the header unfocused. A missing target is left to the browser.
 * 8. The home carousel (`#carousel-holder`, pages/home.ts): Previous/Next move `.current` to the
 *    previous/next slide in `.carousel-slides`, wrapping around; the buttons sit outside the slides,
 *    so focus stays on them. `.carousel-slides` (the slides only, not the buttons) gets
 *    `aria-live="polite"` on the first click, so nothing is announced at load. No auto-advance (C205).
 * 9. "Load More News" (`button.load-more[aria-controls]`): reveals every `.hidden-article` in its
 *    target, removes itself and moves focus to the first revealed card's headline link.
 *
 * 10. The release page's Print button (`button.print-document`, pages/release.ts) calls `window.print()`.
 * 11. The release page's language buttons (`button[data-story-lang]`): "secondary" adds
 *     `body.lang-secondary` (overrides.css shows the French `.story-lang.secondary` and hides the
 *     English `.story-lang.primary`, the h1 among them) and makes `.story-headline` the level-1
 *     heading (`role="heading" aria-level="1"`); "primary" undoes both. `<html lang>` stays "en"
 *     (P2-R3): the French content carries its own `lang="fr"`. The pressed button's own line is
 *     hidden by the switch, so focus moves to the button that switches back.
 *
 * 12. The Live Webcast button (`#live-button`, header.ts), present on every page but only polled
 *     when it exists: on load and every 60 s, `GET {base}/assets/live.json` (no-store; the base is the
 *     button's own `{base}/live/` href minus its tail). `{"live":true}` swaps `live_button_hide` for
 *     `live_button_show`; anything else, or any failure, leaves (or puts) it hidden. Errors are
 *     swallowed: a dead file must not spam every visitor's console.
 *
 * 13. The /live/ page's Play button (`.wowza-wrapper[data-stream] button.play-button`, pages/live.ts),
 *     the only thing that ever contacts the stream host: on click it hides `.placeholder-container`
 *     and shows the `video`; with native HLS (`canPlayType("application/vnd.apple.mpegurl")`) it sets
 *     `video.src`, otherwise it appends one `<script>` for `{base}/assets/vendor/hls.light.min.js`
 *     (the base is site.js's own URL minus its tail), and on its load runs `new Hls()`,
 *     `loadSource(stream)`, `attachMedia(video)`. Then `video.play()`. Any failure (script, an
 *     unsupported Hls, a fatal hls.js error, the media element's error, a rejected play()) writes the
 *     fallback sentence into `#live-status`.
 *
 * DOM is built with createElementNS/textContent only. Exported as a string so a test can evaluate it
 * in jsdom against a renderPage() document (site-script.test.ts). It must never contain `</script>`.
 */
// The base is stripped only on a segment boundary ("/sitemap-old" under "/site" keeps "sitemap").
// At most 100 UTF-16 units, cut between words; a single over-long first word is cut between code
// points (for...of), so no surrogate pair is ever split.
const PATH_WORDS_SRC = String.raw`const pathWords = (pathname, base) => {
  let p = pathname;
  if (base && p.indexOf(base) === 0 && (p.length === base.length || p.charAt(base.length) === "/")) p = p.slice(base.length);
  try { p = decodeURIComponent(p); } catch (_) {}
  const words = p.split(/[\/\-_.+\s]+/).filter((t) => t && !/^(index|html|htm|aspx)$/i.test(t));
  let out = "";
  for (const w of words) {
    const next = out ? out + " " + w : w;
    if (next.length > 100) break;
    out = next;
  }
  if (!out && words.length) {
    for (const ch of words[0]) {
      if (out.length + ch.length > 100) break;
      out += ch;
    }
  }
  return out;
};`;

/** The 404 search prefill's words, evaluated from the same source SITE_SCRIPT embeds (so tests cover the shipped code). */
export const pathWords: (pathname: string, base: string) => string = new Function(`${PATH_WORDS_SRC}\nreturn pathWords;`)();

export const SITE_SCRIPT = String.raw`(() => {
  const doc = document;
  ${PATH_WORDS_SRC}
  const SVG = "http://www.w3.org/2000/svg";
  const OPEN_ICON = { "i-bars": "i-xmark", "i-angle-down": "i-angle-up", "i-search": "i-xmark" };

  const news = doc.getElementById("news-dropdown");
  if (news && news.hasAttribute("data-menu") && doc.getElementById("menu")) {
    const btn = doc.createElement("button");
    btn.setAttribute("type", "button");
    btn.id = "news-dropdown";
    btn.className = "nav-link";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "menu");
    btn.textContent = news.textContent;
    // The sprite URL is the one the header's other icons already use.
    const any = doc.querySelector("header use");
    const sprite = ((any && any.getAttribute("href")) || "").replace(/#.*$/, "");
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = doc.createElementNS(SVG, "use");
    use.setAttribute("href", sprite + "#i-angle-down");
    svg.appendChild(use);
    btn.appendChild(svg);
    news.replaceWith(btn);
  }

  const toggles = Array.prototype.slice.call(doc.querySelectorAll("button[aria-controls][aria-expanded]:not([data-banner-toggle])"));
  const targetOf = (btn) => doc.getElementById(btn.getAttribute("aria-controls"));
  const isOpen = (btn) => btn.getAttribute("aria-expanded") === "true";

  const setIcon = (btn, open) => {
    const use = btn.querySelector("use");
    if (!use) return;
    const href = use.getAttribute("href") || "";
    const at = href.lastIndexOf("#");
    const id = href.slice(at + 1);
    const closedId = btn.getAttribute("data-icon") || id;
    if (!btn.hasAttribute("data-icon")) btn.setAttribute("data-icon", closedId);
    const next = open ? OPEN_ICON[closedId] || closedId : closedId;
    use.setAttribute("href", href.slice(0, at + 1) + next);
  };

  const set = (btn, open) => {
    const target = targetOf(btn);
    if (!target) return;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("active", open);
    target.classList.toggle("show", open);
    setIcon(btn, open);
    if (target.id === "menu") doc.body.classList.toggle("menu-open", open);
  };

  // Closing a panel closes any panel opened from inside it (the phone drawer's News menu).
  const close = (btn) => {
    const target = targetOf(btn);
    toggles.forEach((inner) => inner !== btn && isOpen(inner) && target && target.contains(inner) && close(inner));
    set(btn, false);
  };

  toggles.forEach((btn) => {
    if (!targetOf(btn)) return;
    btn.addEventListener("click", () => {
      if (isOpen(btn)) return close(btn);
      // One panel at a time, except the one this button sits in (the phone drawer stays open under News).
      toggles.forEach((other) => {
        const target = targetOf(other);
        if (other !== btn && isOpen(other) && !(target && target.contains(btn))) close(other);
      });
      set(btn, true);
    });
  });

  // Escape acts only when focus is on an open panel's button or inside the panel — or on nothing at
  // all (the body: a mouse click in Safari or macOS Firefox leaves focus there) — and then closes the
  // innermost such panel (the one holding no other candidate's button), so a keypress on some other
  // control never moves focus.
  doc.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const at = doc.activeElement;
    const nowhere = !at || at === doc.body || at === doc.documentElement;
    const open = toggles.filter((b) => isOpen(b) && targetOf(b) && (nowhere || b === at || targetOf(b).contains(at)));
    const btn = open.find((b) => !open.some((o) => o !== b && targetOf(b).contains(o)));
    if (!btn) return;
    close(btn);
    btn.focus();
  });

  const banner = doc.getElementById("banner");
  const bannerToggles = Array.prototype.slice.call(doc.querySelectorAll("button[data-banner-toggle]"));
  const syncBanner = () => {
    bannerToggles.forEach((b) => {
      b.parentElement.hidden = false;
      b.setAttribute("aria-expanded", banner.hidden ? "false" : "true");
    });
  };
  if (banner) {
    // A banner shown before this script ran: Blue Bridge's, or a site banner whose fetch beat it —
    // even one its own close button already hid again (a non-empty #site-banner was shown), so the
    // (i) toggle still appears, collapsed.
    const siteBanner = doc.getElementById("site-banner");
    if (doc.getElementById("bridge-banner") || (siteBanner && (!siteBanner.hidden || siteBanner.firstElementChild))) syncBanner();
    doc.addEventListener("site-banner-shown", syncBanner);
    // Delegated: the site banner's close button is built after this script may have run.
    doc.addEventListener("click", (ev) => {
      const t = ev.target;
      const close = t && t.closest ? t.closest("#btnCloseBanner, #btnCloseBannerBridge") : null;
      if (!close) return;
      banner.hidden = true;
      syncBanner();
      // The focused close button just vanished with #banner: hand focus to the (i) toggle that
      // brings it back — the one the CSS shows at this width (offsetParent is null when hidden).
      const shown = bannerToggles.filter((b) => b.offsetParent !== null)[0];
      if (shown) shown.focus();
    });
    bannerToggles.forEach((b) =>
      b.addEventListener("click", () => {
        banner.hidden = !banner.hidden;
        syncBanner();
      }),
    );
  }

  const pageSearch = doc.querySelector("a[data-page-search]");
  if (pageSearch) {
    pageSearch.addEventListener("click", (ev) => {
      const box = doc.getElementById((pageSearch.getAttribute("href") || "").slice(1));
      if (!box) return;
      ev.preventDefault();
      if (box.scrollIntoView) box.scrollIntoView({ block: "center" });
      box.focus({ preventScroll: true });
    });
  }

  const carousel = doc.getElementById("carousel-holder");
  const track = carousel && carousel.querySelector(".carousel-slides");
  if (carousel && track) {
    const slides = Array.prototype.slice.call(track.querySelectorAll(":scope > .home-banner"));
    carousel.addEventListener("click", (ev) => {
      const t = ev.target;
      const nav = t && t.closest ? t.closest("button.story-nav") : null;
      if (!nav || slides.length < 2) return;
      const at = Math.max(0, slides.findIndex((s) => s.classList.contains("current")));
      const step = nav.classList.contains("story-previous") ? -1 : 1;
      const next = slides[(at + step + slides.length) % slides.length];
      track.setAttribute("aria-live", "polite");
      slides.forEach((s) => s.classList.toggle("current", s === next));
    });
  }

  Array.prototype.slice.call(doc.querySelectorAll("button.load-more[aria-controls]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = doc.getElementById(btn.getAttribute("aria-controls"));
      if (!target) return;
      const shown = Array.prototype.slice.call(target.querySelectorAll(".hidden-article"));
      shown.forEach((card) => card.classList.remove("hidden-article"));
      btn.remove();
      const link = shown.length ? shown[0].querySelector("h2 a") : null;
      if (link) link.focus();
    });
  });

  Array.prototype.slice.call(doc.querySelectorAll("button.print-document")).forEach((btn) => {
    btn.addEventListener("click", () => window.print());
  });

  const langButtons = Array.prototype.slice.call(doc.querySelectorAll("button[data-story-lang]"));
  langButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const secondary = btn.getAttribute("data-story-lang") === "secondary";
      doc.body.classList.toggle("lang-secondary", secondary);
      Array.prototype.slice.call(doc.querySelectorAll(".story-headline")).forEach((h) => {
        if (secondary) {
          h.setAttribute("role", "heading");
          h.setAttribute("aria-level", "1");
        } else {
          h.removeAttribute("role");
          h.removeAttribute("aria-level");
        }
      });
      const back = langButtons.filter((b) => b.getAttribute("data-story-lang") === (secondary ? "primary" : "secondary"))[0];
      if (back) back.focus();
    });
  });

  const live = doc.getElementById("live-button");
  if (live) {
    let liveUrl = "/assets/live.json";
    try { liveUrl = new URL(live.href, location.href).pathname.replace(/\/live\/$/, "") + liveUrl; } catch (_) {}
    const poll = () => {
      try {
        fetch(liveUrl, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const on = !!j && j.live === true;
            live.classList.toggle("live_button_show", on);
            live.classList.toggle("live_button_hide", !on);
          })
          .catch(() => {});
      } catch (_) {}
    };
    poll();
    setInterval(poll, 60000);
  }

  const wowza = doc.querySelector(".wowza-wrapper[data-stream]");
  const playBtn = wowza && wowza.querySelector("button.play-button");
  const player = wowza && wowza.querySelector("video");
  if (playBtn && player) {
    const stream = wowza.getAttribute("data-stream");
    const status = doc.getElementById("live-status");
    const holder = wowza.querySelector(".placeholder-container");
    let started = false;
    const fail = () => { if (status) status.textContent = "The webcast can't play here. Use the stream link below."; };
    const start = () => {
      try {
        const p = player.play();
        if (p && p.catch) p.catch(fail);
      } catch (_) { fail(); }
    };
    const withHls = () => {
      const H = window.Hls;
      if (!H || (H.isSupported && !H.isSupported())) return fail();
      try {
        const hls = new H();
        if (hls.on && H.Events) hls.on(H.Events.ERROR, (_ev, d) => { if (d && d.fatal) fail(); });
        hls.loadSource(stream);
        hls.attachMedia(player);
        start();
      } catch (_) { fail(); }
    };
    playBtn.addEventListener("click", () => {
      if (started) return;
      started = true;
      if (holder) holder.hidden = true;
      player.hidden = false;
      player.addEventListener("error", fail);
      if (player.canPlayType && player.canPlayType("application/vnd.apple.mpegurl")) {
        player.src = stream;
        return start();
      }
      const site = doc.querySelector('script[src$="/assets/site/site.js"]');
      const s = doc.createElement("script");
      s.src = ((site && site.getAttribute("src")) || "/assets/site/site.js").replace(/site\/site\.js$/, "vendor/hls.light.min.js");
      s.addEventListener("load", withHls);
      s.addEventListener("error", fail);
      doc.head.appendChild(s);
    });
  }

  const prefill = doc.querySelector("form[data-prefill-from-path] #not-found-q");
  if (prefill && !prefill.value) {
    // The base is the form's action ({base}/search/) minus its tail.
    let base = "";
    try { base = new URL(prefill.form.action).pathname.replace(/\/search\/$/, ""); } catch (_) {}
    prefill.value = pathWords(location.pathname, base);
  }
})();`;
