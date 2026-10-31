import { escapeHtml } from "@gcpe/http-kit";
import { basePath, renderPage, type PageOptions, type SiteInfo } from "./render";
import { sanitizeBodyHtml } from "./sanitize-body";
import { themeDefaults } from "./settings";
import type { SiteStorage } from "./storage";

const e = (s: string) => escapeHtml(s);

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

  // Resolves true once the list is in, false if it failed (after the alert); an empty list removes
  // its fieldset (the Emergency case). Keys are compared lowercased; nothing from the caller reaches the DOM.
  function loadCategories(container, selected) {
    const category = container.dataset.category;
    const wanted = selected && Array.isArray(selected[category]) ? selected[category].map((k) => String(k).toLowerCase()) : [];
    return api("SubscriptionItems/" + encodeURIComponent(category))
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((items) => {
        if (Array.isArray(items) && items.length === 0) {
          container.remove();
          return;
        }
        for (const item of items) {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = category + ":" + item.key;
          input.value = item.key;
          if (wanted.includes(String(item.key).toLowerCase())) input.checked = true;
          label.appendChild(input);
          label.appendChild(document.createTextNode(" " + item.value));
          container.appendChild(label);
        }
        return true;
      })
      .then((ok) => ok !== false, () => {
        say("Couldn't load topics. Reload the page to try again.", "alert");
        return false;
      });
  }

  // The subscribe page asks all-or-customize with radios; the manage page keeps its "All news" checkbox.
  function readForm(form) {
    const radio = form.querySelector('input[type="radio"][name="isAllNews"]:checked');
    const isAllNews = form.querySelector('input[type="radio"][name="isAllNews"]') ? !!radio && radio.value === "true" : form.elements.isAllNews.checked;
    const subscribedCategories = {};
    for (const input of form.querySelectorAll('fieldset[data-category] input[type="checkbox"]')) {
      if (!input.checked) continue;
      const category = input.name.split(":")[0];
      (subscribedCategories[category] ??= []).push(input.value);
    }
    return {
      emailAddress: form.elements.emailAddress.value,
      subscribedCategories: form.querySelector('input[type="radio"][name="isAllNews"]') && isAllNews ? {} : subscribedCategories,
      isAllNews,
      isAsItHappens: form.elements.isAsItHappens.checked,
      isDailyDigest: form.elements.isDailyDigest.checked,
    };
  }

  if (kind === "subscribe") {
    const form = document.getElementById("subscribe-form");
    const custom = document.getElementById("newsOnDemandCustomOptions");
    const showCustom = (on) => {
      form.querySelector('input[name="isAllNews"][value="' + (on ? "false" : "true") + '"]').checked = true;
      custom.hidden = !on;
    };
    // Set when the link asked for topics whose list couldn't load: customize can't honour it.
    let blocked = false;
    const BLOCKED = "Couldn't load the topics your link chose, so you can't subscribe to them yet. Reload the page to try again.";
    const save = document.getElementById("save");
    // The radios stay where they are (and keep focus) while the options show or hide.
    form.addEventListener("change", (ev) => {
      if (!ev.target || ev.target.name !== "isAllNews") return;
      const all = ev.target.value === "true";
      custom.hidden = all;
      if (blocked) {
        // All news needs no list, so Subscribe works; customize waits for a reload again.
        save.disabled = !all;
        say(all ? "" : BLOCKED, "alert");
      }
    });
    // Query prefill: the values only choose which baked boxes to check, by exact lowercased key.
    const wanted = {};
    const params = new URLSearchParams(location.search);
    for (const [param, category] of [["ministries", "ministries"], ["sectors", "sectors"], ["tags", "tags"], ["topics", "tags"], ["themes", "themes"], ["emergency", "emergency"]]) {
      for (const raw of params.getAll(param)) {
        for (const value of raw.split(",")) {
          const key = value.trim().toLowerCase();
          if (key) (wanted[category] ??= []).push(key);
        }
      }
    }
    const fieldsets = Array.from(form.querySelectorAll("fieldset[data-category]"));
    Promise.all(fieldsets.map((f) => loadCategories(f, wanted))).then((loaded) => {
      // A list the link asked for (?ministries=… etc.) failed: never fall back to all news without
      // saying so. Customize stays chosen and Subscribe waits for a reload (or a switch to all news).
      // Another list failing only warns (loadCategories).
      if (fieldsets.some((f, i) => loaded[i] === false && wanted[f.dataset.category])) {
        blocked = true;
        showCustom(true);
        save.disabled = true;
        say(BLOCKED, "alert");
        return;
      }
      if (form.querySelector('fieldset[data-category] input:checked')) showCustom(true);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      const choice = readForm(form);
      if (!choice.isAllNews && Object.keys(choice.subscribedCategories).length === 0) {
        say("Choose at least one area, or select all news.", "alert");
        form.querySelector('input[name="isAllNews"][value="false"]').focus();
        return;
      }
      const r = await postJson("CreateNewsOnDemandEmailSubscriptionWithPreferences", choice);
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

  // Reached from an email's Unsubscribe link (a stable token that never expires) or from the
  // manage page's Unsubscribe button (its 24-hour manage link, or an old system's link). Only the
  // button unsubscribes: mail scanners open links too. The API answers true even for a token it
  // doesn't know (C50), so the page checks what it can itself: a token cut short in the email, an
  // expired manage link, and any failed call. It says "unsubscribed" only on a real true.
  if (kind === "unsubscribe") {
    const token = qs("token") || "";
    const form = document.getElementById("unsubscribe-form");
    const btn = document.getElementById("confirm-unsubscribe");
    const help = document.getElementById("unsubscribe-help");
    const STABLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.\\d{1,9}\\.[A-Za-z0-9_-]{43}$/;
    const MANAGE = /^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{22}2|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
    const FAILED = "We couldn't unsubscribe you. You're still subscribed. Try again in a few minutes.";
    const cannot = (text) => {
      form.hidden = true;
      help.hidden = false;
      say(text, "alert");
    };
    if (!STABLE.test(token) && !MANAGE.test(token)) {
      cannot("This unsubscribe link isn't complete. It may have been cut off in your email.");
    } else if (MANAGE.test(token)) {
      // The API answers true for an expired manage link without unsubscribing anyone, so the
      // button waits for the check to say the link is good; a failed check says so instead.
      btn.disabled = true;
      api("CheckEmailActivationToken/" + encodeURIComponent(token))
        .then((r) => (r.ok ? r.json() : null))
        .then((valid) => {
          if (valid === true) btn.disabled = false;
          else if (valid === false) cannot("This link has expired.");
          else cannot(FAILED);
        })
        .catch(() => cannot(FAILED));
    }
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      let done = false;
      try {
        const r = await api("UnsubscribeSubscriber/" + encodeURIComponent(token));
        done = r.ok && (await r.json()) === true;
      } catch {
        done = false;
      }
      if (done) {
        say("You're unsubscribed. You won't get any more email from BC Gov News On Demand.", "status");
      } else {
        btn.disabled = false;
        help.hidden = false;
        say(FAILED, "alert");
      }
    });
  }
})();`;

function renderSubscribePage(site: SiteInfo, opts: PageOptions): string {
  const bp = basePath(site);
  const text = (opts.settings ?? themeDefaults(site.theme)).pageText;
  const rich = (html: string) => sanitizeBodyHtml(html, { images: false });
  const body = `<div class="connect subscribe mb-3">
<div class="home-body" id="main-content-release">
<h1 class="connect-title">Subscribe</h1>
<p class="manage-link">If you already have a subscription to News On Demand you can <a href="${e(`${bp}/subscribe/manage/`)}">manage your account or unsubscribe</a>.</p>
<form id="subscribe-form">
<details class="expandable-section" id="newsOnDemand" open>
<summary><h2>${e(site.name)} On Demand</h2></summary>
<div class="expandable-section-content">
<p>Get your news delivered to your mobile or desktop. Subscribe to receive your news as it happens or receive a daily news digest at 5 p.m.</p>
<p class="fw-bold">When would you like your news delivered to your mobile or desktop?</p>
<ul class="external-links">
<li><label><input type="checkbox" name="isAsItHappens" checked> As soon as it's published.</label></li>
<li><label><input type="checkbox" name="isDailyDigest"> In a daily digest after 5 p.m.</label></li>
</ul>
<fieldset class="audience">
<legend>Let us know what areas of the B.C. government you're interested in.</legend>
<div><label><input type="radio" name="isAllNews" value="true" checked> I would like to receive news from all ministries and sectors.</label></div>
<div><label><input type="radio" name="isAllNews" value="false"> I would like to customize the news that I receive.</label></div>
</fieldset>
<div id="newsOnDemandCustomOptions" class="mb-3" hidden>
${categoryFieldsets()}
</div>
</div>
</details>
<div id="noticeOfCollection">
<p><b>${e(text.collectionNotice.heading)}</b></p>
${rich(text.collectionNotice.bodyHtml)}
</div>
<div class="email-row">
<label for="email">What email address would you like to use for notifications?</label>
<input type="email" id="email" name="emailAddress" required autocomplete="email">
</div>
<button type="submit" id="save" class="btn">Subscribe</button>
</form>
<p id="message" role="status"></p>
<p id="message-alert" role="alert"></p>
${rich(text.subscribeHelpHtml)}
</div>
</div>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Subscribe", site, `${bp}/subscribe/`, body, opts, ' data-page="subscribe"');
}

function renderManagePage(site: SiteInfo, opts: PageOptions): string {
  const bp = basePath(site);
  const unsubscribePath = `${bp}/subscribe/unsubscribe/`;
  const body = `<div class="connect subscribe">
<div class="home-body" id="main-content-release">
<h1 class="connect-title">Manage Subscription</h1>
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
</div>
</div>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Manage your subscription", site, `${bp}/subscribe/manage/`, body, opts, ' data-page="manage"');
}

/** Opened by the Unsubscribe link in every subscriber email (NoD recipient-links.ts) and by the
 * manage page's Unsubscribe button, with `?token=`. The help line, hidden until something goes
 * wrong, points to the manage page, where a new link can be requested by email. */
function renderUnsubscribePage(site: SiteInfo, opts: PageOptions): string {
  const bp = basePath(site);
  const body = `<h1>Unsubscribe</h1>
<div id="unsubscribe-form">
<p>Press the button below to stop receiving BC Gov News On Demand.</p>
<button type="button" id="confirm-unsubscribe">Unsubscribe</button>
</div>
<p id="message" role="status"></p>
<p id="message-alert" role="alert"></p>
<p id="unsubscribe-help" hidden>You can also go to <a href="${e(`${bp}/subscribe/manage/`)}">Manage Subscription</a>, ask for a new link by email, and unsubscribe from there.</p>
<script>${SUBSCRIBE_SCRIPT}</script>`;
  return renderPage("Unsubscribe", site, `${bp}/subscribe/unsubscribe/`, body, opts, ' data-page="unsubscribe"');
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
