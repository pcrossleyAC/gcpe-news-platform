import { useState, type FormEvent } from "react";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";

/** From/To as BC calendar days. The parent keys this on the range it shows, so the server's
 * resolved default (the last 30 days) fills both fields. */
export function RangeForm({ from, to, onApply }: { from: string; to: string; onApply(from: string, to: string): void }): React.JSX.Element {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(f, t);
  };
  return (
    <Form onSubmit={submit} aria-label="Date range" className="gcpe-reports__range">
      <TextField label="From (BC date)" type="date" value={f} onChange={setF} />
      <TextField label="To (BC date)" type="date" value={t} onChange={setT} />
      <Button type="submit">Show</Button>
      <p>Up to 92 days at a time.</p>
    </Form>
  );
}
