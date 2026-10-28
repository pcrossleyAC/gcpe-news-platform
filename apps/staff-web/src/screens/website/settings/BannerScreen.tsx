import { useId } from "react";
import { Checkbox, InlineAlert, Radio, RadioGroup, TextArea, TextField } from "@bcgov/design-system-react-components";
import type { BannerSettings, LinkSetting, SiteSettings } from "@gcpe/site-settings";
import { useTenantTimeZoneStatus } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { instantToBcLocal } from "../../release/timezone";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Site banner";
const MESSAGE_MAX = 300;

/** The banner as this form holds it: the schedule as BC wall-clock "YYYY-MM-DDTHH:mm" ("" = blank), as a datetime-local input shows it. */
interface BannerForm extends Omit<BannerSettings, "startsAt" | "endsAt"> {
  startsAtLocal: string;
  endsAtLocal: string;
}

type BannerType = "off" | BannerSettings["style"];

function toLocal(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const { date, time } = instantToBcLocal(iso, timeZone);
  return `${date}T${time}`;
}

/**
 * `/hub/website/banner` (spec "Hub screens", Banner): the site-wide banner — Off / Information /
 * Emergency (Off keeps the style), message, links, an optional schedule in BC time and a
 * preview. Reads need NRMS.SiteEditor or Core.Admin; writes NRMS.SiteEditor.
 */
export function BannerScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-banner">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the site banner.</p>
      </div>
    );
  }
  return <BannerEditor canEdit={session.has("NRMS.SiteEditor")} />;
}

/** Waits for the tenant time zone before loading: the form shows the schedule in that zone's
 * wall-clock, and the server reads what it sends back in the same zone. */
function BannerEditor({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const { timeZone, resolved } = useTenantTimeZoneStatus();
  if (!resolved) {
    return (
      <div className="gcpe-site-banner">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }
  return <BannerFields canEdit={canEdit} timeZone={timeZone} />;
}

function BannerFields({ canEdit, timeZone }: { canEdit: boolean; timeZone: string }): React.JSX.Element {
  const editor = useSettingsEditor<"banner", BannerForm>("banner", {
    fromDocument: ({ startsAt, endsAt, ...rest }) => ({ ...rest, startsAtLocal: toLocal(startsAt, timeZone), endsAtLocal: toLocal(endsAt, timeZone) }),
    // The server converts the BC wall-clock times to instants (site-routes.ts's bannerWithInstants).
    toRequest: ({ startsAtLocal, endsAtLocal, links, ...rest }) => ({
      ...rest,
      links: withoutBlankLinks(links),
      startsAtLocal: startsAtLocal || null,
      endsAtLocal: endsAtLocal || null,
    }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-banner">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-banner">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const errorOf = (field: string) => {
    const message = fieldErrors.find((e) => e.field === `banner.${field}`)?.message;
    return { errorMessage: message, isInvalid: message !== undefined };
  };
  const set = (patch: Partial<BannerForm>) => editor.setValue((v) => ({ ...v, ...patch }));
  const type: BannerType = value.enabled ? value.style : "off";

  return (
    <div className="gcpe-site-banner">
      <h1>{TITLE}</h1>

      <RadioGroup
        label="Banner type"
        value={type}
        onChange={(t) => set(t === "off" ? { enabled: false } : { enabled: true, style: t as BannerSettings["style"] })}
        isDisabled={!canEdit}
        {...errorOf("style")}
      >
        <Radio value="off">Off</Radio>
        <Radio value="info">Information</Radio>
        <Radio value="emergency">Emergency</Radio>
      </RadioGroup>

      <TextArea
        label="Message"
        value={value.message}
        onChange={(message) => set({ message })}
        description={`${value.message.length} / ${MESSAGE_MAX}`}
        isDisabled={!canEdit}
        {...errorOf("message")}
      />

      <LinkListEditor
        legend="Links"
        links={value.links}
        onChange={(links) => set({ links })}
        errors={fieldErrors}
        pathPrefix="banner.links"
        reorderable={false}
        withSummary={false}
        isDisabled={!canEdit}
      />

      <TextField
        label="Show from"
        type="datetime-local"
        description="BC time. Leave blank to show it right away."
        value={value.startsAtLocal}
        onChange={(startsAtLocal) => set({ startsAtLocal })}
        isDisabled={!canEdit}
        {...errorOf("startsAt")}
      />
      <TextField
        label="Hide after"
        type="datetime-local"
        description="BC time. Leave blank to keep it up until it's turned off."
        value={value.endsAtLocal}
        onChange={(endsAtLocal) => set({ endsAtLocal })}
        isDisabled={!canEdit}
        {...errorOf("endsAt")}
      />

      <Checkbox isSelected={value.dismissible} onChange={(dismissible) => set({ dismissible })} isDisabled={!canEdit}>
        Visitors can close the banner
      </Checkbox>

      <BannerPreview banner={value} colors={state.document.theme.colors} />

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="banner" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}

/** Roughly how the public site shows it: white text on the theme's banner colour. Links are shown, not followed. */
function BannerPreview({ banner, colors }: { banner: BannerForm; colors: SiteSettings["theme"]["colors"] }): React.JSX.Element {
  const headingId = useId();
  const links: LinkSetting[] = withoutBlankLinks(banner.links);
  return (
    <section aria-labelledby={headingId} className="gcpe-site-banner__preview">
      <h2 id={headingId}>Preview</h2>
      {banner.enabled ? (
        <div className="gcpe-site-banner__sample" style={{ background: banner.style === "emergency" ? colors.bannerEmergency : colors.bannerInfo, color: "#FFFFFF", padding: "0.75rem 1rem" }}>
          <p>{banner.message}</p>
          {links.length > 0 && (
            <ul>
              {links.map((link, i) => (
                <li key={i}>
                  <span style={{ textDecoration: "underline" }}>{link.text}</span>
                </li>
              ))}
            </ul>
          )}
          {banner.dismissible && <span aria-hidden="true">×</span>}
        </div>
      ) : (
        <p>The banner is off, so visitors don&rsquo;t see it.</p>
      )}
    </section>
  );
}
