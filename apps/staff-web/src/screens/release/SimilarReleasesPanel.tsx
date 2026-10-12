import { useEffect, useId, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { isSafeUrl } from "@gcpe/http-kit/url";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";

/** Shown under the button while the staff-AI flag is on (addendum §7). */
export const AI_NOTE = "Sends this draft's text to the AI service to compare.";

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

/** Falls back to the raw string on an unparseable `publishDate` rather than letting
 * `Intl.DateTimeFormat` throw (M2: a defensive backstop — the News API response is already
 * validated in NRMS before it reaches here). */
function dateText(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** The status region's full text, including the AI-fallback sentence when it applies — folded
 * in here (rather than a separate paragraph outside the live region) so a screen-reader user
 * hears it, and shown only when there are results to qualify. */
function statusText(found: SimilarResponse | null, ai: boolean): string {
  if (!found) return "";
  const n = found.results.length;
  if (n === 0) return "No similar published releases found.";
  const base = `Found ${n} similar published release${n === 1 ? "" : "s"}.`;
  return ai && found.mode === "text" ? `${base} The AI service wasn’t available, so these are text matches.` : base;
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
      <Button onPress={() => void find()} isPending={busy} aria-describedby={ai ? noteId : undefined}>
        Find similar
      </Button>
      {ai && (
        <p id={noteId} className="gcpe-similar__note">
          {AI_NOTE}
        </p>
      )}
      <div role="status">{busy ? "Looking for similar releases…" : statusText(found, ai)}</div>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {found && found.results.length > 0 && (
        <ol className="gcpe-similar__results">
          {found.results.map((r) => {
            const href = typeof r.url === "string" && isSafeUrl(r.url) ? r.url : null;
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
