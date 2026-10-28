import { useId } from "react";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { THEME_COLOR_KEYS, contrastRatio, type ThemeColors } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { ResetToDefaults } from "./ResetToDefaults";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Theme colours";
const MIN_CONTRAST = 4.5;
const WHITE = "#FFFFFF";
const HEX = /^#[0-9A-Fa-f]{6}$/;

type ColorKey = keyof ThemeColors;
type Colors = ThemeColors;

const COLOR_LABEL: Record<ColorKey, string> = {
  primary: "Header and buttons",
  primaryText: "Text on the header and buttons",
  accent: "Accent",
  text: "Body text",
  mutedText: "Secondary text",
  surface: "Panels",
  background: "Page background",
  border: "Borders",
  bannerInfo: "Information banner",
  bannerEmergency: "Emergency banner",
};

/** A pair the server checks (spec "Contrast pairs"): `where` is the spec's wording for it. */
interface Pair {
  fg: (c: Colors) => string;
  bg: (c: Colors) => string;
  where: string;
}
const TEXT_ON_BACKGROUND: Pair = { fg: (c) => c.text, bg: (c) => c.background, where: "on the page background" };
const TEXT_ON_SURFACE: Pair = { fg: (c) => c.text, bg: (c) => c.surface, where: "on panels" };
const ON_HEADER: Pair = { fg: (c) => c.primaryText, bg: (c) => c.primary, where: "on the header" };
// The primary colour is also every link's colour (P7) and sits behind legacy's hard-coded white text.
const LINK_ON_BACKGROUND: Pair = { fg: (c) => c.primary, bg: (c) => c.background, where: "as link text" };
const WHITE_ON_PRIMARY: Pair = { fg: () => WHITE, bg: (c) => c.primary, where: "behind white text" };
const WHITE_ON_INFO: Pair = { fg: () => WHITE, bg: (c) => c.bannerInfo, where: "behind white text" };
const WHITE_ON_EMERGENCY: Pair = { fg: () => WHITE, bg: (c) => c.bannerEmergency, where: "behind white text" };

/** Each colour's badges: the pair(s) it belongs to, on either side. Accent, secondary text and borders aren't checked. */
const PAIRS: Partial<Record<ColorKey, Pair[]>> = {
  text: [TEXT_ON_BACKGROUND, TEXT_ON_SURFACE],
  background: [TEXT_ON_BACKGROUND, LINK_ON_BACKGROUND],
  surface: [TEXT_ON_SURFACE],
  primaryText: [ON_HEADER],
  primary: [ON_HEADER, LINK_ON_BACKGROUND, WHITE_ON_PRIMARY],
  bannerInfo: [WHITE_ON_INFO],
  bannerEmergency: [WHITE_ON_EMERGENCY],
};

const upper = (hex: string) => hex.trim().toUpperCase();

/**
 * `/hub/website/theme` (spec "Hub screens", Theme): a colour input per colour with its hex, a
 * live "Readable r:1" / "Too faint r:1" badge and a preview of the colours being edited. Reads
 * need NRMS.SiteEditor or Core.Admin; writes NRMS.SiteEditor.
 */
export function ThemeScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-theme">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the theme colours.</p>
      </div>
    );
  }
  return <ThemeFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function ThemeFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"theme">("theme", {
    fromDocument: (theme) => theme,
    // Colours go out upper-case, as the stored document and the public site have them.
    toRequest: ({ colors }) => ({ colors: Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, upper(colors[k])])) }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-theme">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-theme">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const colors = value.colors;
  const setColor = (key: ColorKey, hex: string) => editor.setValue((v) => ({ ...v, colors: { ...v.colors, [key]: hex } }));

  return (
    <div className="gcpe-site-theme">
      <h1>{TITLE}</h1>

      {THEME_COLOR_KEYS.map((key) => (
        <ColorRow
          key={key}
          colorKey={key}
          colors={colors}
          error={fieldErrors.find((e) => e.field === `theme.colors.${key}`)?.message}
          onChange={(hex) => setColor(key, hex)}
          isDisabled={!canEdit}
        />
      ))}

      {canEdit && <ResetToDefaults editor={editor as SettingsEditor<unknown>} apply={(d) => editor.setValue(d.theme)} done="Colours reset to the defaults. Save or publish to keep them." />}

      <ThemePreview colors={colors} />

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="theme" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}

interface ColorRowProps {
  colorKey: ColorKey;
  colors: Colors;
  error: string | undefined;
  onChange(hex: string): void;
  isDisabled: boolean;
}

function ColorRow({ colorKey, colors, error, onChange, isDisabled }: ColorRowProps): React.JSX.Element {
  const badgesId = useId();
  const label = COLOR_LABEL[colorKey];
  const hex = colors[colorKey];
  // A badge needs both colours of its pair to be real colours; a half-typed hex has none yet.
  const badges = (PAIRS[colorKey] ?? []).flatMap((pair) => {
    const fg = pair.fg(colors);
    const bg = pair.bg(colors);
    return HEX.test(fg) && HEX.test(bg) ? [{ ratio: contrastRatio(fg, bg), where: pair.where }] : [];
  });
  return (
    <div className="gcpe-site-theme__color">
      <TextField
        label={label}
        value={hex}
        onChange={onChange}
        isDisabled={isDisabled}
        isInvalid={error !== undefined}
        errorMessage={error}
        aria-describedby={badges.length > 0 ? badgesId : undefined}
      />
      <input
        type="color"
        aria-label={`${label} colour picker`}
        value={HEX.test(hex) ? hex.toLowerCase() : "#000000"}
        onChange={(e) => onChange(upper(e.target.value))}
        disabled={isDisabled}
      />
      <span id={badgesId} className="gcpe-site-theme__badges">
        {badges.map(({ ratio, where }, i) => {
          const readable = ratio >= MIN_CONTRAST;
          return (
            <span key={where} className={readable ? "gcpe-site-theme__badge gcpe-site-theme__badge--ok" : "gcpe-site-theme__badge gcpe-site-theme__badge--faint"}>
              <strong>{`${readable ? "Readable" : "Too faint"} ${ratio.toFixed(1)}:1`}</strong>
              {` ${where}`}
              {i < badges.length - 1 ? "; " : ""}
            </span>
          );
        })}
      </span>
    </div>
  );
}

/** Roughly how the public site looks with the colours being edited (not the saved ones). Decorative, so hidden from assistive technology. */
function ThemePreview({ colors }: { colors: Colors }): React.JSX.Element {
  const headingId = useId();
  const strip = (id: string, background: string, text: string) => (
    <p data-testid={id} style={{ background, color: WHITE, margin: 0, padding: "0.5rem 1rem" }}>
      {text}
    </p>
  );
  return (
    <section aria-labelledby={headingId} className="gcpe-site-theme__preview">
      <h2 id={headingId}>Preview</h2>
      <div aria-hidden="true" style={{ border: `1px solid ${colors.border}`, background: colors.background, color: colors.text }}>
        {strip("preview-info", colors.bannerInfo, "Information banner: a notice for visitors")}
        {strip("preview-emergency", colors.bannerEmergency, "Emergency banner: an urgent notice")}
        <div style={{ background: colors.primary, color: colors.primaryText, padding: "0.75rem 1rem" }}>Site header</div>
        <div style={{ padding: "1rem" }}>
          <p>Page text on the page background.</p>
          <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, padding: "0.75rem 1rem" }}>
            <p style={{ margin: 0 }}>A panel</p>
            <p style={{ margin: 0, color: colors.mutedText }}>Secondary text on the panel</p>
            <span style={{ display: "inline-block", marginTop: "0.5rem", padding: "0.25rem 0.75rem", background: colors.accent, color: colors.text }}>Accent</span>
          </div>
        </div>
      </div>
    </section>
  );
}
