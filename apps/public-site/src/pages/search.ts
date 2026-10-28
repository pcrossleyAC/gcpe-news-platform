import type { MinistryDto } from "../dto";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId } from "../site-paths";

/**
 * One inline script (no third-party assets): reads `q`/`ministry`/`sector`/`page` from the
 * current URL, calls `/api/v2/search` and renders the results (text optional when a ministry or
 * sector is given: a filter-only search, headed "Latest <ministry> news") — every element built with
 * `document.createElement`/`textContent`, never `innerHTML`, so a hostile headline from the API
 * can never become markup. Result links are built from the key the same way `pageUrl` builds a
 * release link; the API's own `url` is never used (Q81: same origin by default).
 *
 * A fetch failure's own error message is never shown verbatim — `fail()` tags the three known
 * outcomes (400/429/other-non-ok) with a fixed `userMessage`, and the `catch` only ever displays
 * that tagged message or, for anything else (a real network failure), the same generic sentence
 * a non-ok response gets.
 */
export const SEARCH_SCRIPT = `(() => {
  const run = () => {
    const form = document.getElementById("search-form");
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim();
    const ministry = params.get("ministry") || "";
    const sector = params.get("sector") || "";
    const page = Math.max(1, Math.min(50, parseInt(params.get("page") || "1", 10) || 1));
    const status = document.getElementById("search-status");
    const alertEl = document.getElementById("search-alert");
    const list = document.getElementById("results");
    const heading = document.getElementById("results-heading");
    const pages = document.getElementById("pages");
    const siteBase = form.dataset.siteBase;
    const apiBase = form.dataset.apiBase || location.origin;
    const select = document.getElementById("ministry");
    document.getElementById("q").value = q;
    select.value = ministry;
    // No text but a ministry or sector (the ministry page's "Search <ministry> news" link) is a
    // filter-only search: the API lists that filter's posts, newest first, as legacy did.
    if (!q && !ministry && !sector) return;
    const chosen = ministry ? Array.from(select.options).find((o) => o.value !== "" && o.value === ministry.toLowerCase()) : undefined;
    heading.textContent = q ? "Results" : chosen ? "Latest " + chosen.textContent + " news" : "Latest news";
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const date = (s) => { const m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s || ""); return m ? MONTHS[+m[2] - 1] + " " + (+m[3]) + ", " + m[1] : ""; };
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (ministry) query.set("ministry", ministry);
    if (sector) query.set("sector", sector);
    query.set("page", String(page));
    status.textContent = "Searching…";
    const GENERIC = "Search isn't available right now. You can browse the archive instead.";
    const fail = (userMessage) => { const err = new Error(userMessage); err.userMessage = userMessage; throw err; };
    fetch(apiBase.replace(/\\/+$/, "") + "/api/v2/search?" + query.toString())
      .then((r) => {
        if (r.status === 400) fail("Enter between 1 and 200 characters to search.");
        if (r.status === 429) fail("Too many searches. Wait a minute and try again.");
        if (!r.ok) fail(GENERIC);
        return r.json();
      })
      .then((data) => {
        const results = Array.isArray(data.results) ? data.results : [];
        const total = Number(data.total) || 0;
        heading.hidden = false;
        if (results.length === 0) { status.textContent = "No results."; return; }
        const first = (page - 1) * 20 + 1;
        status.textContent = "Results " + first + " to " + (first + results.length - 1) + " of " + total + ".";
        for (const r of results) {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = siteBase + "/releases/" + encodeURIComponent(String(r.key)) + "/";
          a.textContent = String(r.headline || r.key);
          li.appendChild(a);
          const t = document.createElement("time");
          t.dateTime = String(r.publishDate || "");
          t.textContent = " " + date(r.publishDate);
          li.appendChild(t);
          if (r.summary) { const p = document.createElement("p"); p.textContent = String(r.summary); li.appendChild(p); }
          list.appendChild(li);
        }
        const nav = document.createElement("nav");
        nav.setAttribute("aria-label", "Search results pages");
        const link = (n, rel, text) => { const p = new URLSearchParams(location.search); p.set("page", String(n)); const a = document.createElement("a"); a.href = "?" + p.toString(); a.rel = rel; a.textContent = text; nav.appendChild(a); nav.appendChild(document.createTextNode(" ")); };
        if (page > 1) link(page - 1, "prev", "Previous page");
        if (first + results.length - 1 < total && page < 50) link(page + 1, "next", "Next page");
        if (nav.childNodes.length) pages.appendChild(nav);
      })
      .catch((err) => { status.textContent = ""; alertEl.textContent = err && typeof err.userMessage === "string" ? err.userMessage : GENERIC; });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();`;

/** The static search page over `/api/v2/search` (spec §6.3). `apiBase` is `""` on the
 * same origin (Q81's working assumption); only `SEARCH_API_URL` sets it to another host. */
export function renderSearchPage(ministries: MinistryDto[], site: SiteInfo, opts: PageOptions, apiBase: string): string {
  const base = basePath(site);
  const options = ministries
    .filter((m) => m.isActive && categoryPageId("ministries", m.key))
    .map((m) => `<option value="${e(m.key.toLowerCase())}">${e(m.name)}</option>`)
    .join("\n");
  const body = `<h1>Search news</h1>
<form role="search" action="${e(base)}/search/" method="get" id="search-form" data-api-base="${e(apiBase)}" data-site-base="${e(base)}">
<p><label for="q">Search for</label><br><input type="search" id="q" name="q" maxlength="200"></p>
<p><label for="ministry">Ministry</label><br><select id="ministry" name="ministry"><option value="">All ministries</option>
${options}
</select></p>
<p><button type="submit">Search</button></p>
</form>
<noscript><p>Search needs JavaScript. You can <a href="${e(base)}/archive/">browse the archive by month</a> or <a href="${e(base)}/ministries/">news by ministry</a> instead.</p></noscript>
<div id="search-status" role="status"></div>
<div id="search-alert" role="alert"></div>
<h2 id="results-heading" hidden>Results</h2>
<ol id="results" aria-labelledby="results-heading"></ol>
<div id="pages"></div>
<script>${SEARCH_SCRIPT}</script>`;
  return renderPage("Search news", site, `${base}/search/`, body, { ...opts, hideHeaderSearch: true });
}
