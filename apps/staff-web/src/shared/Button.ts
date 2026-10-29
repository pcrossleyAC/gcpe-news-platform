import type { ComponentProps, Ref } from "react";
import { Button as BcButton } from "@bcgov/design-system-react-components";

/**
 * The design system's Button, with `ref` in its props type. React 19 passes `ref` through as an
 * ordinary prop, and the design system hands every prop on to react-aria's Button (which forwards
 * it to the `<button>` element), so a screen that moves focus back to a button after closing a
 * form can hold a ref to it directly. The design system's own type just doesn't declare it.
 */
export const Button = BcButton as (props: ComponentProps<typeof BcButton> & { ref?: Ref<HTMLButtonElement> }) => React.JSX.Element;
