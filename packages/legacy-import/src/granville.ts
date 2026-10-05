/**
 * Legacy stores several on/off `ApplicationSetting` flags — `granville` (Project Blue Bridge),
 * `live_webcast_enabled`, and the emergency-pin flags `IsPinnedSlide`/`IsPinnedSecondarySlide` —
 * as the literal strings `"true"`/`"false"` (Hub.Legacy `*.aspx.cs`: `SetAppSetting(x, enabled ?
 * "true" : "false")`, read back with `GetAppSetting(x).ToLower() == "true"`). Shared by every
 * consumer that reads one of these settings — the public site, NRMS's own `getBlueBridge`, and
 * both legacy importers (News API's and NRMS's) — so the ON rule never drifts between them.
 */
export function isGranvilleOn(value: string | null | undefined): boolean {
  return value != null && value.trim().toLowerCase() === "true";
}

/** Normalises a raw legacy `ApplicationSetting` value to exactly `"true"` (NRMS's own on-value) or `null`. */
export function normalizeGranville(raw: string | null | undefined): string | null {
  return isGranvilleOn(raw) ? "true" : null;
}
