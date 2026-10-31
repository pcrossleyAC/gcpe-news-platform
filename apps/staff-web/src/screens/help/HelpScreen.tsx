import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { useSession, type SessionValue } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { TableScroll } from "../../shared/TableScroll";
import { GLOSSARY, type GlossaryArea } from "../../shared/glossary";
import { isApplePlatform, SHORTCUTS, shortcutText, shortcutWords } from "../../shared/shortcuts";
import { hasAnyReadRole } from "../../shell/nav";
import { MANUALS, visibleManuals } from "../../manuals/catalog";
import { canManageWebsite, canReadWebsite } from "../website/access";
import { canEditSubscribers, canReadSubscribers } from "../subscribers/access";
import { canEditReleases } from "../release/access";
import { hasCalendarRole } from "../calendar/access";
import { isCoreAdmin } from "../admin/organizations/access";

interface HowTo {
  area: GlossaryArea;
  /** The same rule the side navigation uses to show the area. */
  show(session: SessionValue): boolean;
  /** Each pointer, with `show` when only some of the area's roles can do it. */
  items: { show?(session: SessionValue): boolean; text: React.ReactNode }[];
}

/** The keys for a shortcut as this device names them ("⌘S" / "Ctrl+S"). */
const mod = (key: "S" | "Enter" | "K") => shortcutText(key === "S" ? "save" : key === "Enter" ? "submit" : "search");

/** Short pointers to what each area does, worded from the screens as built (only what is true). */
const HOW_TO: HowTo[] = [
  {
    area: "Releases",
    show: hasAnyReadRole,
    items: [
      {
        show: canEditReleases,
        text: (
          <>
            <strong>Start a release:</strong> in <Link to="/releases">Releases</Link>, choose New release, fill in the form and choose Create release ({mod("Enter")}).
          </>
        ),
      },
      {
        show: canEditReleases,
        text: (
          <>
            <strong>Save your edits:</strong> Save changes, in the bar along the bottom of the release, saves every section you changed ({mod("S")}). A section with edits not yet saved says Unsaved beside its heading.
          </>
        ),
      },
      {
        show: canEditReleases,
        text: (
          <>
            <strong>Approve, publish or schedule:</strong> use Actions, at the top of the release. Each asks first; Publish now and Schedule say who will be emailed. They wait until your edits are saved.
          </>
        ),
      },
      {
        show: canEditReleases,
        text: (
          <>
            <strong>Plan a time without committing it:</strong> the planned publish date in Publish settings is only a plan. Schedule commits the time.
          </>
        ),
      },
      {
        show: canEditReleases,
        text: (
          <>
            <strong>Correct a published release:</strong> edit it and save; it republishes. Subscribers and media lists aren&rsquo;t emailed again.
          </>
        ),
      },
      {
        text: (
          <>
            <strong>Find a release:</strong> type its number (NEWS-00007) or some of its words into Find a release, at the top of the side menu ({mod("K")} goes there on screens without a search or filter box of their own). A number opens the release; words open <Link to="/search">Search</Link>, where you can narrow by ministry or sector.
          </>
        ),
      },
    ],
  },
  {
    area: "Website",
    show: canReadWebsite,
    items: [
      {
        show: canManageWebsite,
        text: (
          <>
            <strong>Change the banner, footer and other site settings:</strong> make your changes, Save draft ({mod("S")}), then Publish. Nothing is live until you publish. Settings history lists every published revision and can restore one.
          </>
        ),
      },
      {
        show: canManageWebsite,
        text: (
          <>
            <strong>Change the home page carousel:</strong> edit the next carousel and save it; it goes live at its Go live at time, or choose Make live now. Changes to the live carousel publish at once, so it asks first.
          </>
        ),
      },
    ],
  },
  {
    area: "Subscribers",
    show: canReadSubscribers,
    items: [
      {
        text: (
          <>
            <strong>Find a subscriber:</strong> in <Link to="/subscribers">Subscribers</Link>, type part of their email in Email contains ({mod("K")} goes there).
          </>
        ),
      },
      {
        show: canEditSubscribers,
        text: (
          <>
            <strong>Change what someone gets:</strong> open them, change their preferences and choose Save preferences ({mod("S")}). Back to results (or the browser&rsquo;s Back) returns to the same results.
          </>
        ),
      },
    ],
  },
  {
    area: "Calendar",
    show: hasCalendarRole,
    items: [
      {
        text: (
          <>
            <strong>Add an activity:</strong> in the <Link to="/calendar">Calendar</Link>, choose New activity, fill it in and choose Save ({mod("S")} or {mod("Enter")}).
          </>
        ),
      },
      {
        text: (
          <>
            <strong>Edit an activity:</strong> open it from the list, change it and choose Save ({mod("S")}). You&rsquo;re taken back to the list with that activity in view and marked.
          </>
        ),
      },
      {
        text: (
          <>
            <strong>Narrow the list:</strong> open Filters ({mod("K")} opens it and goes to Search for). Saved views keeps filters you use often.
          </>
        ),
      },
      {
        text: (
          <>
            <strong>Make a report:</strong> Export and reports, above the list, makes the Look Ahead, 30/60/90 and Planning PDFs and the Excel export from the list&rsquo;s current filter.
          </>
        ),
      },
      {
        text: (
          <>
            <strong>Change something during the daily change freeze:</strong> the list says when the freeze is on; ask the Corp Cal Manager to make an urgent change for you.
          </>
        ),
      },
    ],
  },
];

const AREAS: GlossaryArea[] = ["Releases", "Website", "Subscribers", "Calendar"];

/**
 * `/hub/help`: for every signed-in user, linked from the header. The manuals for this user's roles, How do I (pointers for the areas
 * this user can open), the keyboard shortcuts (from shared/shortcuts.tsx, the registry the keys
 * themselves use) and the glossary (shared/glossary.ts, which the "?" explanations also use).
 */
export function HelpScreen(): React.JSX.Element {
  useDocumentTitle("Help");
  const session = useSession();
  const { hash } = useLocation();
  const apple = isApplePlatform();

  // A link to one entry ("More in Help") lands on it. After the shell's own move to the h1,
  // which runs after this screen's effects on a route change.
  useEffect(() => {
    if (!hash) return;
    const timer = setTimeout(() => {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      target?.scrollIntoView?.({ block: "start" });
      target?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [hash]);

  const manuals = visibleManuals(session).map((id) => MANUALS.find((m) => m.id === id)!);
  // Each area's pointers this user can act on; an area with none left is left out, heading and all.
  const howTo = HOW_TO.filter((h) => h.show(session))
    .map((h) => ({ ...h, items: h.items.filter((item) => !item.show || item.show(session)) }))
    .filter((h) => h.items.length > 0);

  return (
    <div className="gcpe-help">
      <h1>Help</h1>
      <p>What the Hub&rsquo;s screens are for, its keyboard shortcuts, and what its terms mean. Some tasks need an editor&rsquo;s role.</p>
      <nav aria-label="On this page">
        <ul>
          <li>
            <a href="#manuals">Manuals</a>
          </li>
          <li>
            <a href="#how-do-i">How do I…</a>
          </li>
          <li>
            <a href="#shortcuts">Keyboard shortcuts</a>
          </li>
          <li>
            <a href="#glossary">Glossary</a>
          </li>
        </ul>
      </nav>

      <section aria-labelledby="manuals">
        <h2 id="manuals" tabIndex={-1}>
          Manuals
        </h2>
        {manuals.length === 0 && <p>No manuals for your roles yet.</p>}
        {manuals.length > 0 && (
          <ul className="gcpe-help__list">
            {manuals.map((m) => (
              <li key={m.id}>
                <Link to={`/help/manuals/${m.id}`}>{m.title}</Link>
                <span className="gcpe-help__aka"> For: {m.forRoles}</span>
              </li>
            ))}
          </ul>
        )}
        {isCoreAdmin(session) && (
          <p>
            <Link to="/help/manuals-review">Changed since your last review</Link>
          </p>
        )}
      </section>

      <section aria-labelledby="how-do-i">
        <h2 id="how-do-i" tabIndex={-1}>
          How do I…
        </h2>
        {howTo.length === 0 && <p>Your role doesn&rsquo;t open any of the Hub&rsquo;s work areas yet. Ask a Hub administrator for access.</p>}
        {howTo.map((h) => (
          <div key={h.area}>
            <h3 id={`how-${h.area.toLowerCase()}`} tabIndex={-1}>
              {h.area}
            </h3>
            <ul className="gcpe-help__list">
              {h.items.map((item, i) => (
                <li key={i}>{item.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="shortcuts">
        <h2 id="shortcuts" tabIndex={-1}>
          Keyboard shortcuts
        </h2>
        <p>
          {apple ? "On this Mac, use ⌘ (Command)." : "On this computer, use Ctrl."} They work from inside text boxes too. In a dialog, Enter and Esc keep their usual meaning. They don&rsquo;t clash with
          screen readers: NVDA and JAWS use Insert or Caps Lock for their own commands, and VoiceOver uses Control+Option.
        </p>
        <TableScroll label="Keyboard shortcuts">
          <table className="gcpe-table gcpe-help__shortcuts" aria-label="Keyboard shortcuts">
            <thead>
              <tr>
                <th scope="col">Keys</th>
                <th scope="col">What it does</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.id}>
                  <td data-label="Keys">
                    <kbd>{shortcutWords(s.id, apple)}</kbd>
                    {s.modifier && apple && <span className="gcpe-help__keys-short"> ({shortcutText(s.id, apple)})</span>}
                  </td>
                  <td data-label="What it does">{s.does}</td>
                  <td data-label="Where">{s.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section aria-labelledby="glossary">
        <h2 id="glossary" tabIndex={-1}>
          Glossary
        </h2>
        {AREAS.map((area) => (
          <div key={area}>
            <h3 id={`glossary-${area.toLowerCase()}`} tabIndex={-1}>
              {area}
            </h3>
            <dl className="gcpe-help__glossary">
              {GLOSSARY.filter((e) => e.area === area).map((e) => (
                <div key={e.id}>
                  <dt id={`glossary-${e.id}`} tabIndex={-1}>
                    {e.term}
                  </dt>
                  <dd>
                    {e.alsoShownAs && <span className="gcpe-help__aka">Also shown as {e.alsoShownAs.join(", ")}. </span>}
                    {e.definition}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
    </div>
  );
}
