/** Google Search Console verification (url-compat §1d). Both values are operator-set env vars
 * (SITE_GOOGLE_VERIFICATION_FILE, SITE_GOOGLE_SITE_VERIFICATION) and reach a file path and a
 * `<head>` attribute, so each is held to the exact token shape Google issues — env.ts rejects
 * anything else at startup and the writers re-check, so a bad value can never inject markup or
 * escape the output folder. */
export const GOOGLE_VERIFICATION_FILE_RE = /^google[0-9a-f]{16}\.html$/;
export const GOOGLE_SITE_VERIFICATION_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** The site's verification tokens; null for each one the operator hasn't set. */
export interface SiteVerification {
  googleFile: string | null;
  googleMeta: string | null;
}
