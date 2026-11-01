import { useEffect, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canManageWebsite } from "./access";
import { settingsScreenFor } from "./WebsiteScreen";
import type { InternalLink } from "./types";

const SCREEN: Record<Exclude<InternalLink["screen"], "settings">, { label: string; path: string }> = {
  carousel: { label: "Carousel", path: "/website/carousel" },
  pins: { label: "Emergency pins", path: "/website/pins" },
  "live-feed": { label: "Live Feed", path: "/website/live-feed" },
  links: { label: "Resource links", path: "/website/links" },
};

const screenOf = (link: InternalLink) => (link.screen === "settings" && link.section ? settingsScreenFor(link.section) : SCREEN[link.screen as keyof typeof SCREEN]);

/**
 * `/hub/website/address-check` (suite fix W2, owner approved 2026-10-31): every address saved on
 * the Website screens that points at one of the Hub's own (internal) host names, which the public
 * can't open, grouped by the screen that edits it, with Open to that screen. Read-only: the site
 * editor fixes each one there. Site editors and Core administrators, as the other manage screens.
 */
export function AddressCheckScreen(): React.JSX.Element {
  const session = useSession();
  const canManage = canManageWebsite(session);
  useDocumentTitle("Hub address check");
  const [links, setLinks] = useState<InternalLink[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    apiFetch<{ links: InternalLink[] }>("/nrms/api/site/internal-links").then(
      (r) => setLinks(r.links),
      () => setLoadError("Couldn't check the saved addresses. Reload the page to try again."),
    );
  }, [canManage]);

  if (!canManage) {
    return (
      <div className="gcpe-address-check">
        <h1>Hub address check</h1>
        <p>You don&rsquo;t have permission to view the Hub address check.</p>
      </div>
    );
  }

  // One group per screen, in the order the server lists them (the Website tabs' order).
  const groups: { label: string; path: string; links: InternalLink[] }[] = [];
  for (const link of links ?? []) {
    const { label, path } = screenOf(link);
    const group = groups.find((g) => g.path === path) ?? groups[groups.push({ label, path, links: [] }) - 1]!;
    group.links.push(link);
  }

  return (
    <div className="gcpe-address-check">
      <h1>Hub address check</h1>
      <p>
        Web addresses saved on the Website screens that point at the Hub itself. You can open them, but the public can&rsquo;t, so visitors get a broken link or image. Open each screen and
        replace the address: for a file, use its <strong>Copy public address</strong> on <Link to="/website/files">Files</Link>.
      </p>
      <p>This checks the live and next carousels, the emergency pins, the Live Feed, the resource links and the published site settings.</p>
      {loadError ? (
        <InlineAlert variant="danger" role="alert" description={loadError} />
      ) : links === null ? (
        <p>Loading…</p>
      ) : links.length === 0 ? (
        <p>Nothing saved on the Website points at the Hub.</p>
      ) : (
        <>
          <p>{links.length === 1 ? "1 saved address points at the Hub." : `${links.length} saved addresses point at the Hub.`}</p>
          {groups.map((g) => (
            <section key={g.path} aria-labelledby={`address-check-${g.path.replace(/\W+/g, "-")}`} className="gcpe-address-check__group">
              <h2 id={`address-check-${g.path.replace(/\W+/g, "-")}`}>{g.label}</h2>
              <p>
                <Link to={g.path}>Open {g.label}</Link>
              </p>
              <ul>
                {g.links.map((l, i) => (
                  <li key={i}>
                    {l.where ? `${l.where}: ` : ""}
                    <span className="gcpe-address-check__address">{l.address}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
