import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { Pagination } from "../releases/Pagination";
import { mediaErrorText } from "./labels";
import type { AddMemberBody, MediaHubContactPage } from "./types";

/** Finds Media Hub contacts by name, email or outlet and adds the chosen email (spec §5.3).
 * The term lives in component state and goes to NoD in a POST body, never in a URL. */
export function MediaHubSearch({ onAdd, disabled }: { onAdd(body: AddMemberBody): void; disabled: boolean }): React.JSX.Element {
  const [input, setInput] = useState("");
  const [q, setQ] = useState<string | null>(null);
  // Bumped on every Search press, so searching the same term again fetches it again.
  const [run, setRun] = useState(0);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MediaHubContactPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest search may land.
  const latest = useRef(0);

  useEffect(() => {
    if (q === null) return;
    const seq = ++latest.current;
    apiFetch<MediaHubContactPage>("/nod/api/media-hub/contacts/search", { method: "POST", body: { q, page } }).then(
      (r) => {
        if (seq !== latest.current) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) => {
        if (seq === latest.current) setError(mediaErrorText(e));
      },
    );
  }, [q, page, run]);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPage(1);
    setQ(input.trim());
    setRun((n) => n + 1);
  };

  const contacts = (result?.contacts ?? []).filter((c) => !c.deletedAt);
  return (
    <section aria-labelledby="media-hub-search-heading">
      <h2 id="media-hub-search-heading">Add from Media Hub</h2>
      <Form onSubmit={onSearch} aria-label="Search Media Hub">
        <TextField label="Name, email or outlet" name="q" value={input} onChange={setInput} />
        <Button type="submit">Search Media Hub</Button>
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {result && contacts.length === 0 && <p>No contacts match.</p>}
      {contacts.length > 0 && (
        <ul className="gcpe-subscribers__hub-results">
          {contacts.map((c) => (
            <li key={c.id}>
              <strong>{`${c.firstName} ${c.lastName}`}</strong>
              {c.outlet && ` — ${c.outlet}`}
              <ul>
                {c.emails.map((e) => (
                  <li key={e.ref}>
                    {`${e.address} (${e.kind}${e.preferred ? ", preferred" : ""}) `}
                    <Button variant="secondary" isDisabled={disabled} onPress={() => onAdd({ mediaHubContactId: c.id, emailRef: e.ref })}>
                      {`Add ${e.address}`}
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={setPage} />}
    </section>
  );
}
