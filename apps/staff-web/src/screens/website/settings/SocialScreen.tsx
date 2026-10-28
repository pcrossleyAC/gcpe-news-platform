import { Link, useSearchParams } from "react-router";
import { InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import { NETWORKS, type ConnectSettings, type FieldError, type LinkSetting, type NetworkKey } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Social links";
const SWITCH_NOTE = "Save a draft before switching networks; unsaved edits on this tab are lost when you switch.";

const CONNECT_INTRO = "Both the policy link and the introduction are optional. Leave a field empty to leave it off the Connect page.";
const POLICY_TEXT_HINT = "The words visitors click, shown on the Connect page. 200 characters or fewer, plain text. Needed if you enter a web address.";
const POLICY_URL_HINT = "Where the link goes. https:// only (or a page on this site starting with /), no spaces. Needed if you enter link text.";
const INTRO_HINT = "Shown at the top of the Connect page, above the networks. Plain text only, 300 characters or fewer.";

const CONNECT_PAGE_FIELD = /^connect\.(policyLink|intro)(\.|$)/;
const ACCOUNT_ROW = /^connect\.(\w+)\.accounts\[(\d+)\](.*)$/;
const byText = (a: LinkSetting, b: LinkSetting) => a.text.localeCompare(b.text, undefined, { sensitivity: "accent" });
const count = (n: ConnectSettings[NetworkKey]) => withoutBlankLinks(n.featured).length + withoutBlankLinks(n.accounts).length;

/**
 * `/hub/website/social?network=<key>` (spec "Hub screens", Social links): one tab per network,
 * each with its featured accounts (reorderable, with a Description) and its other accounts
 * (shown sorted by name). Reads need NRMS.SiteEditor or Core.Admin; writes NRMS.SiteEditor.
 */
export function SocialScreen(): React.JSX.Element {
  const session = useSession();
  const [params] = useSearchParams();
  useDocumentTitle(TITLE);
  const requested = params.get("network");
  const network = (NETWORKS.find((n) => n.key === requested) ?? NETWORKS[0]).key;
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-social">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the social links.</p>
      </div>
    );
  }
  // Keyed by network: switching tabs reloads from the server, so edits to the old tab are lost, as the note says.
  return <SocialFields key={network} network={network} canEdit={session.has("NRMS.SiteEditor")} />;
}

function SocialFields({ network, canEdit }: { network: NetworkKey; canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  // The form holds the whole `connect` value, so a save sends every network with only this one's edits.
  const editor = useSettingsEditor<"connect">("connect", {
    fromDocument: (connect) => ({ ...connect, [network]: { ...connect[network], accounts: [...connect[network].accounts].sort(byText) } }),
    toRequest: (connect) => ({
      ...connect,
      [network]: { featured: withoutBlankLinks(connect[network].featured), accounts: withoutBlankLinks(connect[network].accounts).sort(byText) },
    }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-social">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-social">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const set = (patch: Partial<ConnectSettings[NetworkKey]>) => editor.setValue((v) => ({ ...v, [network]: { ...v[network], ...patch } }));
  // Server errors index the STORED accounts; this screen shows them sorted, so move each error to its displayed row.
  const stored = state.document.connect[network].accounts;
  const order = stored.map((_, i) => i).sort((a, b) => byText(stored[a]!, stored[b]!)); // order[displayed] = stored
  const accountsAligned = value[network].accounts.length === stored.length;
  const connectMessage = (field: string) => fieldErrors.find((e) => e.field === `connect.${field}`)?.message;
  const errorOf = (field: string) => {
    const m = connectMessage(field);
    return { errorMessage: m, isInvalid: m !== undefined };
  };
  const setConnect = (patch: Partial<Pick<ConnectSettings, "policyLink" | "intro">>) => editor.setValue((v) => ({ ...v, ...patch }));
  const shownErrors: FieldError[] = fieldErrors
    .filter((e) => e.field.startsWith(`connect.${network}.`))
    .map((e) => {
      const m = accountsAligned ? ACCOUNT_ROW.exec(e.field) : null;
      return m && m[1] === network ? { ...e, field: `connect.${network}.accounts[${order.indexOf(Number(m[2]))}]${m[3]}` } : e;
    });
  // Problems on the other networks block publishing too, but their rows aren't on this tab.
  const elsewhere: FieldError[] = fieldErrors
    .filter((e) => !e.field.startsWith(`connect.${network}.`) && !CONNECT_PAGE_FIELD.test(e.field))
    .map((e) => {
      const other = NETWORKS.find((n) => e.field.startsWith(`connect.${n.key}.`));
      return other ? { ...e, message: `${other.name}: ${e.message}` } : e;
    });
  const name = NETWORKS.find((n) => n.key === network)!.name;

  return (
    <div className="gcpe-site-social">
      <h1>{TITLE}</h1>

      <fieldset>
        <legend>Connect page</legend>
        <p>{CONNECT_INTRO}</p>
        <TextField
          label="Policy link text"
          description={POLICY_TEXT_HINT}
          value={value.policyLink.text}
          onChange={(text) => setConnect({ policyLink: { ...value.policyLink, text } })}
          isDisabled={!canEdit}
          {...errorOf("policyLink.text")}
        />
        <TextField
          label="Policy link URL"
          description={POLICY_URL_HINT}
          value={value.policyLink.url}
          onChange={(url) => setConnect({ policyLink: { ...value.policyLink, url } })}
          isDisabled={!canEdit}
          {...errorOf("policyLink.url")}
        />
        <TextArea
          label="Introduction"
          description={INTRO_HINT}
          value={value.intro}
          onChange={(intro) => setConnect({ intro })}
          isDisabled={!canEdit}
          {...errorOf("intro")}
        />
      </fieldset>

      <nav aria-label="Networks" className="gcpe-section-tabs">
        <ul>
          {NETWORKS.map((n) => (
            <li key={n.key}>
              <Link to={`?network=${n.key}`} aria-current={n.key === network ? "page" : undefined}>
                {`${n.name} ${count(value[n.key])}`}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p>{SWITCH_NOTE}</p>

      <h2>{name}</h2>
      <LinkListEditor
        legend="Featured accounts"
        links={value[network].featured}
        onChange={(featured) => set({ featured })}
        errors={shownErrors}
        pathPrefix={`connect.${network}.featured`}
        reorderable
        withSummary
        isDisabled={!canEdit}
      />
      <LinkListEditor
        legend="Other accounts"
        links={value[network].accounts}
        onChange={(accounts) => set({ accounts })}
        errors={shownErrors}
        pathPrefix={`connect.${network}.accounts`}
        reorderable={false}
        withSummary={false}
        isDisabled={!canEdit}
      />

      <OtherSectionErrors errors={[...elsewhere, ...editor.otherErrors]} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="connect" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
