import "@bcgov/design-tokens/css/variables.css";
import "@bcgov/bc-sans/css/BCSans.css";
import "./styles/global.css";

import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { SessionProvider } from "./session/SessionContext";
import { createAppRouter } from "./router";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <SessionProvider>
    <RouterProvider router={createAppRouter()} />
  </SessionProvider>,
);
