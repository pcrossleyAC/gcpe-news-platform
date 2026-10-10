/**
 * A label that shows short text but keeps a longer accessible name — for controls repeated per
 * row, where a column header or the row itself already says which item they act on.
 *
 * `full` is read by assistive technology (visually hidden); `short` is what's seen (hidden from
 * assistive technology, so the name isn't doubled). `short` must appear in `full` (WCAG 2.5.3,
 * label in name), so speech users can say what they see.
 */
export function ShortLabel({ short, full }: { short: string; full: string }): React.JSX.Element {
  return (
    <>
      <span className="gcpe-visually-hidden">{full}</span>
      <span aria-hidden="true">{short}</span>
    </>
  );
}

/**
 * A label whose leading words are visually hidden: `prefix` is read but not shown, `text` is
 * shown with its first letter capitalised. The label's text content stays exactly
 * `${prefix} ${text}`, so it reads (and matches) as before, while the screen shows just "Display
 * name" or "New password" under a heading that already names the user.
 */
export function HiddenPrefixLabel({ prefix, text }: { prefix: string; text: string }): React.JSX.Element {
  return (
    <>
      <span className="gcpe-visually-hidden">{prefix}</span> <span className="gcpe-first-cap">{text}</span>
    </>
  );
}
