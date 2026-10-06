import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AnnouncerProvider, useAnnouncer } from "./Announcer";

function Trigger({ text }: { text: string }) {
  const { announce } = useAnnouncer();
  return (
    <button type="button" onClick={() => announce(text)}>
      Go
    </button>
  );
}

describe("AnnouncerProvider / useAnnouncer (I4)", () => {
  afterEach(cleanup);

  it("renders one polite status region and updates its text when announce() is called", () => {
    render(
      <AnnouncerProvider>
        <Trigger text="Saved" />
      </AnnouncerProvider>,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");

    act(() => screen.getByRole("button").click());
    expect(region).toHaveTextContent("Saved");
  });

  it("announcing the same text twice in a row still changes the region's content both times", () => {
    render(
      <AnnouncerProvider>
        <Trigger text="Saved" />
      </AnnouncerProvider>,
    );
    const region = screen.getByRole("status");
    act(() => screen.getByRole("button").click());
    const first = region.textContent;
    act(() => screen.getByRole("button").click());
    const second = region.textContent;
    expect(first).toContain("Saved");
    expect(second).toContain("Saved");
    expect(second).not.toBe(first);
  });

  it("useAnnouncer() outside a provider is a harmless no-op (every section's own unit test renders with no AppShell)", () => {
    function Standalone() {
      const { announce } = useAnnouncer();
      announce("ignored");
      return <p>ok</p>;
    }
    expect(() => render(<Standalone />)).not.toThrow();
  });
});
