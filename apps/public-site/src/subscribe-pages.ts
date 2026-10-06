import { escapeHtml } from "@gcpe/http-kit";
import { renderPage, type PageOptions, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

const e = (s: string) => escapeHtml(s);

/** Same computation as render.ts's own (private) `basePath` — the base URL's path with no
 * trailing slash. Needed here to bake the Unsubscribe button's target page in at render time. */
const basePath = (site: SiteInfo): string => new URL(site.baseUrl).pathname.replace(/\/+$/, "");

/** Categories offered as checkbox groups (spec §4; lists.ts's PUBLIC_CATEGORIES). */
const CATEGORIES: { key: string; legend: string }[] = [
  { key: "ministries", legend: "Ministries" },
  { key: "sectors", legend: "Sectors" },
  { key: "themes", legend: "Themes" },
  { key: "tags", legend: "Tags" },
  { key: "emergency", legend: "Emergency Info BC" },
];
const categoryFieldsets = () => CATEGORIES.map((c) => `<fieldset data-category="${c.key}"><legend>${c.legend}</legend></fieldset>`).join("\n");

const timingCheckboxes = (asItHappensChecked: boolean) => `<div><label><input type="checkbox" name="isAllNews"> All news</label></div>
<div><label><input type="checkbox" name="isAsItHappens"${asItHappensChecked ? " checked" : ""}> As it happens</label></div>
<div><label><input type="checkbox" name="isDailyDigest"> Daily digest</label></div>`;

/**
 * One inline script, shared by all three pages, dispatching on `document.body.dataset.page`
 * ("subscribe" | "manage" | "unsubscribe"). No external assets, no innerHTML anywhere — every
 * element is built with `document.createElement`/`textContent` and every response value that
 * reaches the page goes through `textContent` only.
 *
 * Two fixed live regions carry every message ("message", `role="status"`, for a normal
 * outcome; "message-alert", `role="alert"`, for a failure) rather than one element whose role
 * is switched at runtime — a screen reader's handling of a live region's role can be
 * unreliable once that role has already changed.
 */
const SUBSCRIBE_SCRIPT = `(() => {
  const kind = document.body.dataset.page;
  const statusEl = document.getElementById("message");
  const alertEl = document.getElementById("message-alert");

  const api = (path, init) => fetch(location.origin + "/api/Subscribe/" + path + "?api-version=1.0", init);
  const qs = (name) => new URLSearchParams(location.search).get(name);
  const say = (text, role) => {
    const el = role === "alert" ? alertEl : statusEl;
    const other = role === "alert" ? statusEl : alertEl;
    other.textContent = "";
    el.textContent = text;
  };
  const postJson = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const showError = async (r) => {
    const data = await r.json().catch(() => ({}));
    say(Array.isArray(data.issues) ? "Check the email address." : data.error || "Something went wrong.", "alert");
  };

  function loadCategories(container, selected) {
    const category = container.dataset.category;
    api("SubscriptionItems/" + encodeURIComponent(category))
      .then((r) => r.json())
      .then((items) => {
        for (const item of items) {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = category + ":" + item.key;
          input.value = item.key;
          if (selected && selected[category] && selected[category].includes(item.key)) input.checked = true;
          label.appendChild(input);
          label.appendChild(document.createTextNode(" " + item.value));
          container.appendChild(label);
        }
      })
      .catch(() => say("Couldn't load topics. Reload the page to try again.", "alert"));
  }

  function readForm(form) {
    const subscribedCategories = {};
    for (const input of form.querySelectorAll('fieldset[data-category] input[type="checkbox"]')) {
      if (!input.checked) continue;
      const category = input.name.split(":")[0];
      (subscribedCategories[category] ??= []).push(input.value);
    }
    return {
      emailAddress: form.elements.emailAddress.value,
      subscribedCategories,
      isAllNews: form.elements.isAllNews.checked,
      isAsItHappens: form.elements.isAsItHappens.checked,
      isDailyDigest: form.elements.isDailyDigest.checked,
    };
  }

  if (kind === "subscribe") {
    const form = document.getElementById("subscribe-form");
    for (const f of form.querySelectorAll("fieldset[data-category]")) loadCategories(f, null);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await postJson("CreateNewsOnDemandEmailSubscriptionWithPreferences", readForm(form));
      if (r.status === 204) say("Check your email to confirm your subscription.", "status");
      else await showError(r);
    });
  }

  if (kind === "manage") {
    const token = qs("token");
    const requestForm = document.getElementById("request-form");
    const manageForm = document.getElementById("manage-form");
    const unsubBtn = document.getElementById("unsubscribe-button");
    let loadedEmail = "";

    if (!token) {
      requestForm.hidden = false;
    } else {
      api("ConfirmUpdateCreateSubscription/" + encodeURIComponent(token))
        .then((r) => r.json())
        .then((info) => {
          if (info === null || info.expiredLinkOrUnverifiedEmail) {
            say(info === null ? "This link isn't valid. Request a new one below." : "This link has expired. Request a new one below.", "alert");
            requestForm.hidden = false;
            return;
          }
          loadedEmail = info.emailAddress;
          manageForm.elements.emailAddress.value = info.emailAddress;
          manageForm.elements.isAllNews.checked = info.isAllNews;
          manageForm.elements.isAsItHappens.checked = info.isAsItHappens;
          manageForm.elements.isDailyDigest.checked = info.isDailyDigest;
          for (const f of manageForm.querySelectorAll("fieldset[data-category]")) loadCategories(f, info.subscribedCategories);
          manageForm.hidden = false;
        })
        .catch(() => say("Something went wrong. Try again later.", "alert"));
    }

    requestForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await api("ManageNewsOnDemandEmailSubscription/" + encodeURIComponent(requestForm.elements.email.value));
      say("If that address is subscribed, we've emailed it a link.", "status");
    });

    manageForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const info = readForm(manageForm);
      const r = await postJson("UpdateNewsOnDemandEmailSubscriptionWithPreferences/" + encodeURIComponent(token), info);
      if (r.status === 204) {
        if (info.emailAddress.trim().toLowerCase() !== loadedEmail.trim().toLowerCase()) say("We've emailed " + info.emailAddress + " to confirm the change.", "status");
        else say("Your preferences are saved.", "status");
      } else await showError(r);
    });

    unsubBtn.addEventListener("click", () => {
      location.href = unsubBtn.dataset.target + "?token=" + encodeURIComponent(token);
    });
  }

  if (kind === "unsubscribe") {
    const token = qs("token");
    const btn = document.getElementById("confirm-unsubscribe");
    btn.addEventListener("click", async () => {
      try {
        await api("UnsubscribeSubscriber/" + encodeURIComponent(token));
        say("You're unsubscribed.", "status");
        btn.disabled = true;
      } catch {
        say("Something went wrong. Try again.", "alert");
      }
    });
  }
})();`;

function renderSubscribePage(site: SiteInfo, opts: PageOptions): string {
  const body = `<h1>Subscribe to BC Gov News On Demand</h1>
<form id="subscribe-form">
<div><label for="email">Email address</label>
<input type="email" id="email" name="emailAddress" required></div>
${categoryFieldsets()}
${timingCheckboxes(true)}
<button type="submit">Subscribe</button>
</form>
<p id="message" role="status"></p>
<p id="message-alert" role="alert"></p>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Subscribe", site, `${basePath(site)}/subscribe/`, body, opts, ' data-page="subscribe"');
}

function renderManagePage(site: SiteInfo, opts: PageOptions): string {
  const bp = basePath(site);
  const unsubscribePath = `${bp}/subscribe/unsubscribe/`;
  const body = `<h1>Manage your subscription</h1>
<p id="message" role="status"></p>
<p id="message-alert" role="alert"></p>
<form id="request-form" hidden>
<div><label for="request-email">Email address</label>
<input type="email" id="request-email" name="email" required></div>
<button type="submit">Request a new link</button>
</form>
<form id="manage-form" hidden>
<div><label for="manage-email">Email address</label>
<input type="email" id="manage-email" name="emailAddress" required></div>
${categoryFieldsets()}
${timingCheckboxes(false)}
<button type="submit">Save</button>
<button type="button" id="unsubscribe-button" data-target="${e(unsubscribePath)}">Unsubscribe</button>
</form>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Manage your subscription", site, `${bp}/subscribe/manage/`, body, opts, ' data-page="manage"');
}

function renderUnsubscribePage(site: SiteInfo, opts: PageOptions): string {
  const body = `<h1>Unsubscribe</h1>
<p>Press the button below to stop receiving BC Gov News On Demand.</p>
<button type="button" id="confirm-unsubscribe">Unsubscribe</button>
<p id="message" role="status"></p>
<p id="message-alert" role="alert"></p>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Unsubscribe", site, `${basePath(site)}/subscribe/unsubscribe/`, body, opts, ' data-page="unsubscribe"');
}

/** Task 7: the three static test pages, written by `writeSubscribePages` on every startup. */
export const SUBSCRIBE_PAGES: { path: string; render(site: SiteInfo, opts: PageOptions): string }[] = [
  { path: "subscribe/index.html", render: renderSubscribePage },
  { path: "subscribe/manage/index.html", render: renderManagePage },
  { path: "subscribe/unsubscribe/index.html", render: renderUnsubscribePage },
];

export async function writeSubscribePages(storage: SiteStorage, site: SiteInfo, opts: PageOptions): Promise<void> {
  for (const p of SUBSCRIBE_PAGES) await storage.write(p.path, p.render(site, opts));
}
