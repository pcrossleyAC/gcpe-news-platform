import { useEffect, useRef } from "react";
import { InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import type { SiteIdentitySettings } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Site identity";

export const DESCRIPTION_HINT = "Search engines and link previews show this for pages without their own summary. Keep it short (about 150 characters).";
export const TWITTER_HINT = "Shown in link previews, for example @BCGovNews. Leave empty for none.";
export const BANNER_MESSAGE_HINT = "Shown on every page while Project Blue Bridge is on. {age} is replaced by the age in years on the day it shows.";
export const BIRTH_DATE_HINT = "Used for {age}.";
export const OPERATOR_NOTE = "The site name and the BC logo are set by the operator, not here.";

/**
 * `/hub/website/identity`: the public site's description, X account and the Project Blue Bridge
 * banner text and birth date. Reads need NRMS.SiteEditor or Core.Admin; writes NRMS.SiteEditor.
 */
export function SiteIdentityScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-identity">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the site identity.</p>
      </div>
    );
  }
  return <SiteIdentityFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function SiteIdentityFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"siteIdentity">("siteIdentity");
  const { value, state, fieldErrors, pending } = editor;
  const root = useRef<HTMLDivElement>(null);
  const wasPending = useRef(false);

  // When an action ends with problems in this section, put the keyboard on the first invalid field.
  const hasProblems = fieldErrors.length > 0;
  useEffect(() => {
    const finished = wasPending.current && pending === null;
    wasPending.current = pending !== null;
    if (finished && hasProblems) root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [pending, hasProblems]);

  if (editor.loadError) {
    return (
      <div className="gcpe-site-identity">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-identity">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const errorOf = (field: string) => {
    const message = fieldErrors.find((e) => e.field === `siteIdentity.${field}`)?.message;
    return { errorMessage: message, isInvalid: message !== undefined };
  };
  const set = (patch: Partial<SiteIdentitySettings>) => editor.setValue((v) => ({ ...v, ...patch }));
  const setBridge = (patch: Partial<SiteIdentitySettings["blueBridge"]>) => editor.setValue((v) => ({ ...v, blueBridge: { ...v.blueBridge, ...patch } }));

  return (
    <div className="gcpe-site-identity" ref={root}>
      <h1>{TITLE}</h1>
      <p>{OPERATOR_NOTE}</p>

      <TextArea label="Site description" description={DESCRIPTION_HINT} value={value.description} onChange={(description) => set({ description })} isDisabled={!canEdit} {...errorOf("description")} />
      <TextField label="X (Twitter) account" description={TWITTER_HINT} value={value.twitterSite} onChange={(twitterSite) => set({ twitterSite })} isDisabled={!canEdit} {...errorOf("twitterSite")} />

      <fieldset>
        <legend>Project Blue Bridge banner</legend>
        <TextArea label="Banner message" description={BANNER_MESSAGE_HINT} value={value.blueBridge.message} onChange={(message) => setBridge({ message })} isDisabled={!canEdit} {...errorOf("blueBridge.message")} />
        <TextField label="Birth date" type="date" description={BIRTH_DATE_HINT} value={value.blueBridge.birthDate} onChange={(birthDate) => setBridge({ birthDate })} isDisabled={!canEdit} {...errorOf("blueBridge.birthDate")} />
      </fieldset>

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="siteIdentity" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
