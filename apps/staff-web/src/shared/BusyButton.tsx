import { useCallback, type Ref } from "react";
import { Button as DesignSystemButton } from "@bcgov/design-system-react-components";
import { Button as RefButton } from "./Button";
import { ariaKeyShortcuts, ShortcutHint, type ShortcutId } from "./shortcuts";

type DesignSystemButtonProps = React.ComponentProps<typeof DesignSystemButton>;

interface BusyButtonProps extends DesignSystemButtonProps {
  /**
   * Shown in place of the normal children while `isPending` is true. The design system's own
   * pending cue is a focus-ring-coloured box-shadow (`[data-pending]` in global.css), which
   * measures only 2.2:1 against the navy primary button, so a sighted user who isn't looking
   * for it can miss it and click again. Wording is the fallback that doesn't depend on noticing
   * a ring.
   */
  pendingLabel?: string;
  /** The keyboard shortcut(s) that press this button (shared/shortcuts.tsx): shows the (first
   * one's) hint and sets `aria-keyshortcuts`. The screen registers the shortcut itself (useShortcut). */
  shortcut?: ShortcutId | ShortcutId[];
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Thin wrapper around the design system's `Button`: everything passes through unchanged except
 * that, while pending, `pendingLabel` (when given) replaces the children, and `shortcut` adds the
 * key hint. Buttons with no `pendingLabel` keep today's ring-only behaviour.
 */
export function Button({ isPending, pendingLabel, shortcut, children, ref, ...props }: BusyButtonProps): React.JSX.Element {
  // React Aria's Button doesn't pass `aria-keyshortcuts` through to the <button>, so it's set on
  // the element directly.
  const ids = shortcut === undefined ? [] : Array.isArray(shortcut) ? shortcut : [shortcut];
  const keys = ids.length > 0 ? ids.map((id) => ariaKeyShortcuts(id)).join(" ") : null;
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el) {
        if (keys) el.setAttribute("aria-keyshortcuts", keys);
        else el.removeAttribute("aria-keyshortcuts");
      }
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [keys, ref],
  );
  const content =
    isPending && pendingLabel ? (
      pendingLabel
    ) : ids.length > 0 && typeof children !== "function" ? (
      <>
        {children}
        <ShortcutHint id={ids[0]!} />
      </>
    ) : (
      children
    );
  return (
    <RefButton isPending={isPending} {...props} ref={setRef}>
      {content}
    </RefButton>
  );
}
