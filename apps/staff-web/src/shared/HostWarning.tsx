/** W1: the warning under a URL field whose address is on the Hub's own host (see publicAddress.ts's
 * `staffHostWarning`). The field names it with `aria-describedby={id}` while it shows. */
export function HostWarning({ id, text }: { id: string; text: string | null }): React.JSX.Element | null {
  if (!text) return null;
  return (
    <p id={id} className="gcpe-host-warning">
      {text}
    </p>
  );
}
