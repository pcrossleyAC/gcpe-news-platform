/**
 * A wide data table's own horizontal scroller, so a table wider than the screen scrolls inside
 * its box instead of pushing the whole page sideways. Focusable and labelled (WCAG 2.1.1: a
 * keyboard user can scroll it with the arrow keys; axe's scrollable-region-focusable).
 */
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="gcpe-table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
