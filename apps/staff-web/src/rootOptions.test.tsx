import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type RootOptions } from "react-dom/client";
import { CalendarErrorBoundary } from "./screens/calendar/ErrorBoundary";
import { ROOT_OPTIONS } from "./rootOptions";

function Explodes(): React.JSX.Element {
  throw new Error("Sample text a user typed");
}

function renderCaught(options: RootOptions) {
  const el = document.createElement("div");
  const root = createRoot(el, options);
  act(() => root.render(<CalendarErrorBoundary><Explodes /></CalendarErrorBoundary>));
  act(() => root.unmount());
}

const reactAct = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("the app root", () => {
  const wasActEnvironment = reactAct.IS_REACT_ACT_ENVIRONMENT;
  beforeAll(() => {
    reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    reactAct.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  });
  afterEach(() => vi.restoreAllMocks());

  it("doesn't log an error a boundary caught; React's default would", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    renderCaught({});
    expect(logged).toHaveBeenCalled();
    logged.mockClear();
    renderCaught(ROOT_OPTIONS);
    expect(logged).not.toHaveBeenCalled();
  });
});
