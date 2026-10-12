import { useEffect, useId, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";

/** Shown under the button while the staff-AI flag is on (addendum §7). */
export const AI_NOTE = "Sends this draft's text to the AI service to compare.";

/**
 * Same rule as `@gcpe/http-kit`'s `isSafeUrl` (default options: an absolute http/https URL, or a
 * single-slash site-relative path), duplicated here since browser code can never import
 * `@gcpe/http-kit` — its barrel pulls in `express` (api/client.ts's CSRF_HEADER is the same
 * situation, for `@gcpe/auth`). Guards the News API's `url` field before it's written into an
 * `href`: that field is server-built from a configured base URL and the post's own key, but this
 * is the one place in the staff app that renders a News API string as a link.
 */
function isSafeUrl(u: string): boolean {
  // eslint-disable-next-line no-control-regex -- the control-character range is the point.
  if (/[\\\s\u0000-\u001F\u007F]/.test(u)) return false;
  if (u.startsWith("/")) return u[1] !== "/";
  try {
    return ["http:", "https:"].includes(new URL(u).protocol.toLowerCase());
  } catch {
    return false;
  }
}

export interface SimilarRelease {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistry: string | null;
  url: string;
  match: "ai" | "text";
}
export interface SimilarResponse {
  mode: "ai" | "text";
  results: SimilarRelease[];
}
interface SimilarConfig {
  similarAvailable?: boolean;
  staffAi?: boolean;
}

const dateText = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

function statusText(found: SimilarResponse | null): string {
  if (!found) return "";
  const n = found.results.length;
  return n === 0 ? "No similar published releases found." : `Found ${n} similar published release${n === 1 ? "" : "s"}.`;
}

/**
 * "Similar published releases" (addendum §7): nothing runs until Find similar is pressed. NRMS
 * compares the release as last saved and returns up to 10 published posts, each labelled AI or
 * Text match. Hidden when NRMS has no News API to ask (`GET /config`'s similarAvailable).
 */
export function SimilarReleasesPanel({ view, timeZone }: { view: ReleaseView; timeZone: string }): React.JSX.Element | null {
  const headingId = useId();
  const noteId = useId();
  const [config, setConfig] = useState<SimilarConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<SimilarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<SimilarConfig>("/nrms/api/config").then(
      (c) => {
        if (active) setConfig(c);
      },
      () => {
        if (active) setConfig({});
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setFound(null);
    setError(null);
  }, [view.id]);

  if (!config?.similarAvailable) return null;
  const ai = config.staffAi === true;

  const find = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await apiFetch<SimilarResponse>(`/nrms/api/releases/${view.id}/similar`, { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't look for similar releases — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="similar-releases" className="gcpe-release-editor__similar" aria-labelledby={headingId}>
      <h2 id={headingId}>Similar published releases</h2>
      <p className="gcpe-similar__hint">Compares the last saved version of this release with published posts.</p>
      <Button onPress={() => void find()} isDisabled={busy} aria-describedby={ai ? noteId : undefined}>
        Find similar
      </Button>
      {ai && (
        <p id={noteId} className="gcpe-similar__note">
          {AI_NOTE}
        </p>
      )}
      <div role="status">{busy ? "Looking for similar releases…" : statusText(found)}</div>
      {ai && found?.mode === "text" && <p>The AI service wasn&rsquo;t available, so these are text matches.</p>}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {found && found.results.length > 0 && (
        <ol className="gcpe-similar__results">
          {found.results.map((r) => {
            const href = isSafeUrl(r.url) ? r.url : null;
            const label = r.headline || r.key;
            return (
              <li key={r.key}>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {label}
                    <span className="gcpe-visually-hidden"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span>{label}</span>
                )}
                <span className="gcpe-similar__meta">
                  {" "}
                  {dateText(r.publishDate, timeZone)} · {r.leadMinistry ?? "No lead ministry"}
                </span>
                <span className={`gcpe-similar__match gcpe-similar__match--${r.match}`}>{r.match === "ai" ? "AI match" : "Text match"}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
