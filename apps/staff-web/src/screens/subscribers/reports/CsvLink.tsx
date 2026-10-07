/** A plain same-origin link: the session cookie authenticates the GET (no CSRF header needed), and
 * the browser streams the file to disk itself, so nothing is held in the page. */
export function CsvLink({ href, children }: { href: string; children: string }): React.JSX.Element {
  return (
    <p className="gcpe-reports__csv">
      <a href={href} download>
        {children}
      </a>
    </p>
  );
}
