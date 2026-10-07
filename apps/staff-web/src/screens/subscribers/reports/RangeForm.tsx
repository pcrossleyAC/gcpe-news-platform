import { useState, type FormEvent } from "react";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";

/** From/To as BC calendar days. A field shows `from`/`to` until staff type in it, so the server's
 * resolved default (the last 30 days) fills both once the first report lands, but never
 * overwrites what staff have already typed. The parent keys this on the range in the page URL,
 * so a new range there starts a fresh form. */
export function RangeForm({ from, to, onApply }: { from: string; to: string; onApply(from: string, to: string): void }): React.JSX.Element {
  const [typed, setTyped] = useState<{ from?: string; to?: string }>({});
  const f = typed.from ?? from;
  const t = typed.to ?? to;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(f, t);
  };
  return (
    <Form onSubmit={submit} aria-label="Date range" className="gcpe-reports__range">
      <TextField label="From (BC date)" type="date" value={f} onChange={(v) => setTyped((p) => ({ ...p, from: v }))} />
      <TextField label="To (BC date)" type="date" value={t} onChange={(v) => setTyped((p) => ({ ...p, to: v }))} />
      <Button type="submit">Show</Button>
      <p>Up to 92 days at a time.</p>
    </Form>
  );
}
