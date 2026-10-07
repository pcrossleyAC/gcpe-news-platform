import { Link } from "react-router";

/** "Handed off, not bounced" is NoD's own view of a send, not delivery: what happened inside
 * Distribution only shows in Distribution's report. */
export function HandedOffNote(): React.JSX.Element {
  return (
    <p>
      &ldquo;Handed off, not bounced&rdquo; counts emails handed to Distribution, minus bounces. Emails still queued in Distribution, or
      that Distribution failed to send, are not visible here; see the{" "}
      <Link to="/subscribers/reports/distribution">Distribution sent and bounced</Link> report.
    </p>
  );
}
