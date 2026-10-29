import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/** Where the list tools' messages go: an area under the tools line that is always shown, so a
 * report's, the export's or Clear LA Status's result is seen and announced even after its panel
 * is closed (ActivityListScreen's ListTools). Null outside the list: messages stay in place. */
export const ToolMessageSlot = createContext<HTMLElement | null>(null);

/** A tool's status and error lines, in the list's message area when there is one. */
export function ToolMessages({ children }: { children: React.ReactNode }): React.JSX.Element {
  const slot = useContext(ToolMessageSlot);
  return slot ? createPortal(children, slot) : <>{children}</>;
}
