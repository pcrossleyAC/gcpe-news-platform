import { useEffect, useRef, useState } from "react";

/**
 * A wide data table's own horizontal scroller, so a table wider than the screen scrolls inside
 * its box instead of pushing the whole page sideways. While (and only while) the table is wider
 * than the box, the box is a tab stop, so a keyboard user can scroll it with the arrow keys
 * (WCAG 2.1.1; axe's scrollable-region-focusable); a table that fits adds no extra stop. Its
 * label names the table and says it scrolls, so it isn't announced as a second copy of the
 * table's own name.
 */
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="gcpe-table-scroll" role="region" aria-label={`${label} — scrollable`} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </div>
  );
}
