import type { LinkSetting } from "@gcpe/site-settings";
import type { CategoryDto, GovernmentTermDto, MinistryDto } from "../dto";
import { basePath, e, renderPage, settingsLink, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId, TERM_SLUG } from "../site-paths";
import { termRangeLabel } from "./archive";

/**
 * One inline script (no third-party assets) behind news.gov's search page (legacy
 * `Default/SearchView.cshtml`): it maps the query string, calls `/api/v2/search` and renders the
 * results, the "Showing results" line, the pages and the facet counts.
 *
 * Input from `location` is never trusted:
 * - each known parameter (any case: legacy's `Ministry`, `Content`, `fromDate`, `Date`, `Page`) is
 *   mapped to a value the page itself baked (a ministry or sector key or name from the baked lists,
 *   a post kind, a term's dates) or validated (a real `YYYY-MM-DD` date, a page of 1–100); anything
 *   else (`Language`, `City`, an unknown ministry) is dropped, so the API never answers 400 for a
 *   filter the page built;
 * - the page then stays on that mapped, encoded query (`history.replaceState`);
 * - values reach the page only as `textContent` or an input's `value`.
 *
 * Every element is built with `document.createElement`/`textContent`/`setAttribute`, never
 * `innerHTML`, so a hostile headline or summary from the API can never become markup. Result links
 * are built from the post key (checked against the post-key pattern, then `encodeURIComponent`)
 * under the site base, the way `pageUrl` builds a release link; the API's own `url` is never used.
 *
 * A fetch failure's own error message is never shown verbatim: `fail()` tags the three known
 * outcomes (400/429/other non-ok) with a fixed `userMessage`, and the `catch` shows only that, or
 * for anything else (a network failure) the same generic sentence.
 */
export const SEARCH_SCRIPT = `(() => {
  const run = () => {
    const form = document.getElementById("search-form");
    if (!form) return;
    const siteBase = form.dataset.siteBase || "";
    const apiBase = (form.dataset.apiBase || location.origin).replace(/\\/+$/, "");
    const searchPath = siteBase + "/search/";
    const status = document.getElementById("search-status");
    const alertEl = document.getElementById("search-alert");
    const list = document.getElementById("results");
    const pager = document.getElementById("search-pages");
    const PAGE_SIZE = 10;
    const MAX_PAGE = 100;
    const lower = (s) => String(s).trim().toLowerCase();
    const items = (facet) => Array.from(document.querySelectorAll("#facet-" + facet + " li[data-key]"));
    const linkOf = (li) => li.querySelector("a");
    const paramsOf = (li) => new URL(linkOf(li).getAttribute("href"), location.href).searchParams;
    // A baked entry by its key, else by its name (legacy's Ministry=Health), case-insensitively.
    const pick = (facet, value) => {
      const v = lower(value);
      if (!v) return null;
      return items(facet).find((li) => li.dataset.key === v) || items(facet).find((li) => lower(linkOf(li).textContent) === v) || null;
    };
    const ymd = (s) => {
      const m = /^(\\d{4})[-/](\\d{2})[-/](\\d{2})$/.exec(String(s).trim());
      if (!m) return "";
      const y = +m[1], mo = +m[2], d = +m[3];
      if (y < 1900 || y > 2199) return "";
      const t = new Date(Date.UTC(y, mo - 1, d));
      return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? m[1] + "-" + m[2] + "-" + m[3] : "";
    };

    const raw = Object.create(null);
    for (const [name, value] of new URLSearchParams(location.search)) {
      const n = name.toLowerCase();
      if (!(n in raw) && value.trim() !== "") raw[n] = value;
    }
    // NUL never reaches the API or the box (the API refuses it; it shows as nothing).
    const state = { q: Array.from((raw.q || "").replace(/\\u0000/g, "").trim()).slice(0, 200).join(""), ministry: "", sector: "", type: "", from: "", to: "" };
    const m = raw.ministry === undefined ? null : pick("ministry", raw.ministry);
    if (m) state.ministry = m.dataset.key;
    const s = raw.sector === undefined ? null : pick("sector", raw.sector);
    if (s) state.sector = s.dataset.key;
    // Legacy's Content=Release/Factsheet/Story and the listings' "factsheets & opinion editorials".
    const kind = lower(raw.type || raw.content || "");
    const KINDS = [["release", "releases"], ["factsheet", "factsheets"], ["stor", "stories"], ["update", "updates"]];
    const hit = kind ? KINDS.find((k) => kind.includes(k[0])) : null;
    if (hit) state.type = hit[1];
    state.from = ymd(raw.from || raw.fromdate || "");
    state.to = ymd(raw.to || raw.todate || "");
    if (!state.from && !state.to && raw.date) {
      const term = items("date").find((li) => li.dataset.key === raw.date.trim());
      if (term) { const p = paramsOf(term); state.from = p.get("from") || ""; state.to = p.get("to") || ""; }
    }
    if (state.from && state.to && state.to < state.from) { const x = state.from; state.from = state.to; state.to = x; }
    const pageRaw = raw.page || "1";
    const page = /^\\d{1,6}$/.test(pageRaw) ? Math.min(MAX_PAGE, Math.max(1, parseInt(pageRaw, 10))) : 1;

    const ORDER = ["q", "ministry", "sector", "type", "from", "to"];
    const queryOf = (st, n) => {
      const p = new URLSearchParams();
      for (const k of ORDER) if (st[k]) p.set(k, st[k]);
      if (n > 1) p.set("page", String(n));
      const str = p.toString();
      return str ? "?" + str : "";
    };
    const hrefOf = (st, n) => searchPath + queryOf(st, n);
    if (location.search !== queryOf(state, page)) history.replaceState(null, "", hrefOf(state, page));

    const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
    const link = (href, text) => { const a = el("a", "", text); a.setAttribute("href", href); return a; };
    const icon = (id) => {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const use = document.createElementNS(NS, "use");
      use.setAttribute("href", siteBase + "/assets/site/icons.svg#i-" + id);
      svg.appendChild(use);
      return svg;
    };
    const hidden = (target, name, value) => { const i = el("input"); i.type = "hidden"; i.name = name; i.value = value; target.appendChild(i); };

    // The form and the controls show the mapped search; each form carries the other filters along.
    document.getElementById("q").value = state.q;
    for (const k of ["ministry", "sector", "type", "from", "to"]) if (state[k]) hidden(form, k, state[k]);
    const dates = document.querySelector("#facet-date form.date-range");
    if (dates) {
      dates.elements.namedItem("from").value = state.from;
      dates.elements.namedItem("to").value = state.to;
      for (const k of ["q", "ministry", "sector", "type"]) if (state[k]) hidden(dates, k, state[k]);
    }
    // Each facet link adds its filter to this search, from page 1.
    const OWNS = { ministry: ["ministry"], sector: ["sector"], content: ["type"], date: ["from", "to"] };
    for (const facet of Object.keys(OWNS)) {
      for (const li of items(facet)) {
        const p = paramsOf(li);
        const next = Object.assign({}, state);
        for (const k of OWNS[facet]) next[k] = p.get(k) || "";
        linkOf(li).setAttribute("href", hrefOf(next, 1));
      }
    }

    if (!state.q && !state.ministry && !state.sector && !state.type && !state.from && !state.to) return;
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const day = (v) => { const p = v.split("-"); return MONTHS[+p[1] - 1] + " " + (+p[2]) + ", " + p[0]; };
    // Legacy FormatDateLong from the API's wall-clock string, read as written: no time-zone maths.
    const longDate = (v) => {
      const x = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(typeof v === "string" ? v : "");
      if (!x) return "";
      const y = +x[1], mo = +x[2], d = +x[3], h = +x[4];
      const t = new Date(Date.UTC(y, mo - 1, d));
      if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || +x[5] > 59) return "";
      return WEEKDAYS[t.getUTCDay()] + ", " + MONTHS[mo - 1] + " " + d + ", " + x[1] + " " + (h % 12 === 0 ? 12 : h % 12) + ":" + x[5] + " " + (h < 12 ? "AM" : "PM");
    };
    // A whole, finite, non-negative number from the API, else 0 (Infinity, NaN, text never show).
    const whole = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const count = (v) => String(whole(v)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");

    // An active filter: its group shows only the chosen entry, with a link that removes it.
    const active = {};
    const markActive = () => {
      const remove = (facet, name, chosen) => {
        const ul = document.querySelector("#facet-" + facet + " ul");
        if (!ul) return;
        active[facet] = true;
        for (const li of items(facet)) li.hidden = true;
        let li = chosen;
        if (li) { const a = linkOf(li); a.replaceWith(el("span", "", a.textContent)); }
        else { li = el("li", "active-filter"); ul.insertBefore(li, ul.firstChild); }
        li.hidden = false;
        if (!chosen) li.appendChild(el("span", "", name));
        li.appendChild(document.createTextNode(" "));
        const next = Object.assign({}, state);
        for (const k of OWNS[facet]) next[k] = "";
        const a = link(hrefOf(next, 1), "Remove " + facet.charAt(0).toUpperCase() + facet.slice(1) + " filter");
        a.className = "remove-filter";
        a.rel = "nofollow";
        li.appendChild(a);
      };
      if (state.ministry) remove("ministry", "", items("ministry").find((li) => li.dataset.key === state.ministry));
      if (state.sector) remove("sector", "", items("sector").find((li) => li.dataset.key === state.sector));
      if (state.type) remove("content", "", items("content").find((li) => li.dataset.key === state.type));
      if (state.from || state.to) {
        const term = items("date").find((li) => { const p = paramsOf(li); return (p.get("from") || "") === state.from && (p.get("to") || "") === state.to; });
        const label = state.from && state.to ? day(state.from) + " to " + day(state.to) : state.from ? "From " + day(state.from) : "To " + day(state.to);
        remove("date", label, term);
      }
    };
    markActive();

    const query = new URLSearchParams();
    for (const k of ORDER) if (state[k]) query.set(k, state[k]);
    query.set("page", String(page));
    query.set("pageSize", String(PAGE_SIZE));
    query.set("facets", "1");
    status.textContent = "Searching…";
    const GENERIC = "Search isn't available right now. You can browse the archive instead.";
    const fail = (userMessage) => { const err = new Error(userMessage); err.userMessage = userMessage; throw err; };
    fetch(apiBase + "/api/v2/search?" + query.toString())
      .then((r) => {
        if (r.status === 400) fail("Enter between 1 and 200 characters to search.");
        if (r.status === 429) fail("Too many searches. Wait a minute and try again.");
        if (!r.ok) fail(GENERIC);
        return r.json();
      })
      .then((data) => {
        const results = data && Array.isArray(data.results) ? data.results : [];
        const KEY = /^[A-Za-z0-9-]{1,200}$/;
        let shown = 0;
        for (const r of results) {
          const key = r && typeof r.key === "string" ? r.key : "";
          if (!KEY.test(key)) continue;
          const href = siteBase + "/releases/" + encodeURIComponent(key) + "/";
          const headline = typeof r.headline === "string" && r.headline.trim() ? r.headline : key;
          const card = el("div", "article");
          const h2 = el("h2");
          h2.appendChild(link(href, headline));
          card.appendChild(h2);
          const media = (cls, hash, id, text) => { const d = el("div", "item-medialink " + cls); const a = link(href + hash); a.appendChild(icon(id)); a.appendChild(document.createTextNode(" " + text)); d.appendChild(a); card.appendChild(d); };
          if (r.hasTranslationList === true) media("translations", "#translations", "language", "Translations");
          if (r.hasMediaAssetList === true) media("media-assets", "#assets", "download", "Media Assets");
          card.appendChild(el("div", "item-date", longDate(r.publishDate)));
          const content = el("div", "item-content");
          const text = el("div", "item-text");
          for (const line of (typeof r.summary === "string" ? r.summary : "").split(/\\r?\\n/)) if (line.trim()) text.appendChild(el("p", "", line));
          const more = link(href);
          more.className = "read-more";
          more.appendChild(icon("caret-right"));
          more.appendChild(document.createTextNode(" Read More"));
          more.appendChild(el("span", "visually-hidden", ": " + headline));
          text.appendChild(more);
          content.appendChild(text);
          card.appendChild(content);
          card.appendChild(el("div", "clear"));
          list.appendChild(card);
          shown++;
        }
        // The count is the cards shown (a result with a bad key is skipped); a total smaller than
        // what this page shows (or not a number) is raised to it.
        const first = (page - 1) * PAGE_SIZE + 1;
        const total = Math.max(whole(data && data.total), shown ? first + shown - 1 : 0);
        if (shown > 0) status.textContent = "Showing results " + count(first) + " - " + count(first + shown - 1) + " of " + count(total);
        else if (total > 0) {
          // A page past the end (an old link, a hand-edited ?page=): say so, and offer page 1.
          status.textContent = "There are no results on page " + page + ". This search has " + count(total) + (total === 1 ? " result." : " results.");
          const p = el("p");
          const a = link(hrefOf(state, 1), "Go to the first page of results");
          a.className = "first-page";
          a.rel = "nofollow";
          p.appendChild(a);
          list.appendChild(p);
        } else status.textContent = "No results found.";

        // Pages: at most five numbers around this one, then previous and next.
        const last = Math.min(MAX_PAGE, Math.ceil(total / PAGE_SIZE));
        if (total > 0 && last > 1) {
          const ul = el("ul");
          const item = (child) => { const li = el("li"); li.appendChild(child); ul.appendChild(li); };
          const to = (n, text, rel) => { const a = link(hrefOf(state, n), text); a.rel = rel ? rel + " nofollow" : "nofollow"; return a; };
          if (page > 1) item(to(Math.min(page - 1, last), "« previous", "prev"));
          const start = Math.max(1, Math.min(page - 2, last - 4));
          for (let n = start; n <= Math.min(last, start + 4); n++) {
            if (n === page) { const b = el("b", "", String(n)); b.setAttribute("aria-current", "page"); item(b); }
            else item(to(n, String(n)));
          }
          if (page < last) item(to(page + 1, "next »", "next"));
          pager.appendChild(ul);
          pager.hidden = false;
        }

        // Facet counts (text mode): each list keeps the entries with results, with their counts.
        const facets = data && data.facets && typeof data.facets === "object" ? data.facets : null;
        const GROUPS = { ministry: "ministries", sector: "sectors", content: "types", date: "terms" };
        if (facets) for (const facet of Object.keys(GROUPS)) {
          const rows = facets[GROUPS[facet]];
          if (!Array.isArray(rows) || active[facet]) continue;
          const counts = new Map();
          for (const row of rows) if (row) counts.set(lower(row.key !== undefined ? row.key : row.slug), whole(row.count));
          for (const li of items(facet)) {
            const n = counts.get(li.dataset.key) || 0;
            if (n > 0) li.appendChild(el("span", "", ": " + count(n)));
            else li.hidden = true;
          }
          // Legacy lists an entry facet by count, largest first (the sort is stable); dates keep their order.
          if (facet !== "date") {
            const byCount = items(facet).slice().sort((a, b) => (counts.get(b.dataset.key) || 0) - (counts.get(a.dataset.key) || 0));
            for (const li of byCount) li.parentNode.appendChild(li);
          }
        }
      })
      .catch((err) => { status.textContent = ""; alertEl.textContent = err && typeof err.userMessage === "string" ? err.userMessage : GENERIC; });

  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();`;

/** Legacy's Content facet values, in its order, as post kinds. */
const CONTENT = [
  ["releases", "Release"],
  ["stories", "Story"],
  ["factsheets", "Factsheet"],
  ["updates", "Update"],
] as const;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The lists the filter panel bakes (the script reduces them to the facet counts it is given). */
export interface SearchLists {
  ministries: MinistryDto[];
  sectors: CategoryDto[];
  /** The public government terms, newest first (the snapshot's order). */
  terms: GovernmentTermDto[];
}

/**
 * The search page over `/api/v2/search` in news.gov's look (legacy `Default/SearchView.cshtml`):
 * the "You searched for" box, the results and the pages, then the filter panel (Ministry, Sector,
 * Content, Date with the terms, a date range and the older-archive links from
 * `pageText.searchArchiveLinks`). The results come first in the DOM so reading and focus order put
 * them first; overrides.css floats them right at desktop so the filters show on the left, as legacy. Headings one level up (legacy h3 → h1, h5 → h2; overrides.css restates their
 * metrics). `apiBase` is `""` on the same origin (Q81's working assumption); only `SEARCH_API_URL`
 * sets it to another host. robots.txt keeps `/search/` out of crawls (plan 3).
 */
export function renderSearchPage(lists: SearchLists, archiveLinks: LinkSetting[], site: SiteInfo, opts: PageOptions, apiBase: string): string {
  const base = basePath(site);
  const action = `${base}/search/`;
  const entry = (key: string, text: string, query: string) => `<li data-key="${e(key)}"><a href="${e(`${action}?${query}`)}" rel="nofollow">${e(text)}</a></li>`;
  const ministries = lists.ministries
    .filter((m) => m.isActive && categoryPageId("ministries", m.key))
    .map((m) => entry(m.key.toLowerCase(), m.name, new URLSearchParams({ ministry: m.key.toLowerCase() }).toString()));
  const sectors = lists.sectors
    .filter((c) => c.isActive && categoryPageId("sectors", c.key))
    .map((c) => entry(c.key.toLowerCase(), c.name, new URLSearchParams({ sector: c.key.toLowerCase() }).toString()));
  const content = CONTENT.map(([kind, label]) => entry(kind, label, `type=${kind}`));
  const terms = lists.terms
    .filter((t) => TERM_SLUG.test(t.slug) && YMD.test(t.startDate) && (t.endDate === null || YMD.test(t.endDate)))
    .map((t) => entry(t.slug, termRangeLabel(t.startDate, t.endDate), `from=${t.startDate}${t.endDate ? `&to=${t.endDate}` : ""}`));
  const archive = archiveLinks.map((l) => `<li>${settingsLink(l, site)}</li>`);
  const filter = (id: string, heading: string, inner: string) => `<div class="search-filter" id="facet-${id}">
<h2 class="open">${heading}</h2>
<div class="search-filter-content">
${inner}
</div>
</div>`;
  const ul = (rows: string[]) => `<ul>\n${rows.join("\n")}\n</ul>`;
  const dateRange = `<form class="date-range" action="${e(action)}" method="get">
<fieldset>
<legend>Custom Range</legend>
<label for="search-from">From</label>
<input type="date" id="search-from" name="from" min="1900-01-01" max="2199-12-31">
<label for="search-to">To</label>
<input type="date" id="search-to" name="to" min="1900-01-01" max="2199-12-31">
<button type="submit" class="link-button">Apply</button>
</fieldset>
</form>`;
  const host = new URL(site.baseUrl).host;
  const body = `<div class="search">
<div class="search-body">
<h1>Search</h1>
</div>
<div class="clear"></div>
<div class="home-body search-results">
<div class="search-panel">
<form role="search" action="${e(action)}" method="get" id="search-form" data-api-base="${e(apiBase)}" data-site-base="${e(base)}">
<label for="q">You searched for</label>
<div class="search-panel-bar"><input type="text" id="q" name="q" maxlength="200" placeholder="${e(`Search ${host}`)}"><button type="submit" class="search-trigger" aria-label="Search"></button></div>
</form>
</div>
<noscript><p>Search needs JavaScript. You can <a href="${e(base)}/archive/">browse the archive by month</a> or <a href="${e(base)}/ministries/">news by ministry</a> instead.</p></noscript>
<p class="search-numbers" id="search-status" role="status"></p>
<p id="search-alert" role="alert"></p>
<div id="results"></div>
<nav class="search-pagination bottom" id="search-pages" aria-label="Search pages" hidden></nav>
</div>
<div class="search-panel search-filters">
${filter("ministry", "Ministry", ul(ministries))}
${filter("sector", "Sector", ul(sectors))}
${filter("content", "Content", ul(content))}
${filter("date", "Date", `${dateRange}\n${ul([...terms, ...archive])}`)}
<p class="reset-search"><a href="${e(action)}" class="link-button" rel="nofollow">Reset search</a></p>
</div>
<div class="clear"></div>
</div>
<script>${SEARCH_SCRIPT}</script>`;
  return renderPage("Search", site, action, body, { ...opts, pageSearchInput: "q" });
}
