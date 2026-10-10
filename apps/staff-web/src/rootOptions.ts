import type { RootOptions } from "react-dom/client";

/** By default React writes every error an error boundary catches to the browser console with
 * console.error, stack and all. That error can carry text a user typed or an activity's content, so a
 * caught error is shown by its boundary and written nowhere. Uncaught errors keep React's default
 * reporting. */
export const ROOT_OPTIONS: RootOptions = { onCaughtError: () => {} };
