import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../shared/Button";
import { apiFetch, ApiError } from "../../../api/client";
import { FIX_BELOW, fieldErrorsOf, messagesOf } from "../messages";
import {
  AbbreviationField,
  abbreviationTakenMessage,
  normalizeAbbreviation,
} from "./abbreviation";
import { orgKeyFromName } from "@gcpe/events/org-key";
import type { OrgRecord } from "@gcpe/events/catalogue";

export interface AddOrganizationFormProps {
  /** The loaded list, used to tell an inactive ministry's 409 from an active one's. */
  orgs?: OrgRecord[];
  onCreated: (key: string) => void;
  onCancel: () => void;
}

/**
 * Creates a ministry (`POST /core/api/organizations`, Core.Admin). The web address key is
 * derived from the name by the shared `orgKeyFromName` and can't be changed afterwards, so the
 * form shows it as you type. The abbreviation (NRMS's release-number prefix) is optional here;
 * a taken one is reported on its field, naming the ministry that has it.
 */
export function AddOrganizationForm({
  orgs = [],
  onCreated,
  onCancel,
}: AddOrganizationFormProps): React.JSX.Element {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [abbreviationError, setAbbreviationError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const key = orgKeyFromName(displayName);
  const nameBlank = displayName.trim() === "";
  const keyEmpty = !nameBlank && key === "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameBlank || keyEmpty || busy) return;
    setMessages([]);
    setAbbreviationError(undefined);
    setBusy(true);
    const abbr = normalizeAbbreviation(abbreviation);
    try {
      const created = await apiFetch<OrgRecord>("/core/api/organizations", {
        method: "POST",
        body: {
          displayName: displayName.trim(),
          ...(abbr === "" ? {} : { abbreviation: abbr }),
        },
      });
      onCreated(created.key);
    } catch (caught) {
      const taken = abbreviationTakenMessage(caught);
      const abbrIssue = fieldErrorsOf(caught).find(
        (f) => f.field === "abbreviation",
      );
      if (taken !== null) {
        setAbbreviationError(taken);
        setMessages([FIX_BELOW]);
      } else if (abbrIssue) {
        setAbbreviationError(abbrIssue.message);
        setMessages([
          FIX_BELOW,
          ...messagesOf(caught).filter((m) => m !== abbrIssue.message),
        ]);
      } else if (caught instanceof ApiError && caught.status === 409) {
        const existing =
          (caught.body as { key?: string } | undefined)?.key ?? key;
        const inactive = orgs.find((o) => o.key === existing && !o.isActive);
        setMessages([
          inactive
            ? `${inactive.displayName} already exists but is inactive. Use Reactivate on its row.`
            : `A ministry with this name already exists (${existing}).`,
        ]);
      } else {
        setMessages(messagesOf(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const nameId = `${uid}-name`;
  const hintId = `${uid}-hint`;
  return (
    <form
      onSubmit={submit}
      aria-label="Add a ministry"
      className="gcpe-stack"
      noValidate
    >
      <h2 ref={headingRef} tabIndex={-1}>
        Add a ministry
      </h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <div>
        <label htmlFor={nameId}>Ministry name (required)</label>
        <input
          id={nameId}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-describedby={hintId}
          aria-invalid={keyEmpty}
        />
        <p id={hintId}>
          {keyEmpty
            ? "Use at least one letter or number in the name."
            : key
              ? `Web address: /site/ministries/${key}/`
              : "The web address is made from the name and can't be changed later."}
        </p>
      </div>
      <AbbreviationField
        id={`${uid}-abbr`}
        value={abbreviation}
        onChange={setAbbreviation}
        error={abbreviationError}
      />
      <div className="gcpe-button-row">
        <Button type="submit" isDisabled={nameBlank || keyEmpty}>
          Create ministry
        </Button>
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
