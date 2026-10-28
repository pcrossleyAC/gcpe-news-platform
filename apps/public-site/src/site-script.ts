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
 *    to its button.
 * 5. The banner toggle and the 404 prefill are left for Tasks 9 and 10.
 *
 * DOM is built with createElementNS/textContent only. Exported as a string so a test can evaluate it
 * in jsdom against a renderPage() document (site-script.test.ts). It must never contain `</script>`.
 */
export const SITE_SCRIPT = String.raw`(() => {
  const doc = document;
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
    btn.textContent = "News";
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

  const toggles = Array.prototype.slice.call(doc.querySelectorAll("button[aria-controls][aria-expanded]"));
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

  // Escape acts only when focus is on an open panel's button or inside the panel, and then closes
  // the innermost such panel (the one holding no other candidate's button), so a keypress elsewhere
  // on the page never moves focus.
  doc.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const at = doc.activeElement;
    const open = toggles.filter((b) => isOpen(b) && at && (b === at || (targetOf(b) && targetOf(b).contains(at))));
    const btn = open.find((b) => !open.some((o) => o !== b && targetOf(b).contains(o)));
    if (!btn) return;
    close(btn);
    btn.focus();
  });
})();`;
