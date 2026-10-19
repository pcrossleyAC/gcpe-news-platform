import { Button as DesignSystemButton } from "@bcgov/design-system-react-components";

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
}

/**
 * Thin wrapper around the design system's `Button`: everything passes through unchanged except
 * that, while pending, `pendingLabel` (when given) replaces the children. Buttons with no
 * `pendingLabel` keep today's ring-only behaviour.
 */
export function Button({ isPending, pendingLabel, children, ...props }: BusyButtonProps): React.JSX.Element {
  return (
    <DesignSystemButton isPending={isPending} {...props}>
      {isPending && pendingLabel ? pendingLabel : children}
    </DesignSystemButton>
  );
}
