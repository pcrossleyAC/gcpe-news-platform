import type { ComponentProps, Ref } from "react";
import { Form as BcForm } from "@bcgov/design-system-react-components";

/**
 * The design system's Form, with `ref` in its props type (as shared/Button.ts does for Button):
 * React 19 passes `ref` as an ordinary prop and the design system hands it on to the `<form>`, so
 * a keyboard shortcut can submit the form (shared/shortcuts.tsx's useFormShortcut).
 */
export const Form = BcForm as (props: ComponentProps<typeof BcForm> & { ref?: Ref<HTMLFormElement> }) => React.JSX.Element;
