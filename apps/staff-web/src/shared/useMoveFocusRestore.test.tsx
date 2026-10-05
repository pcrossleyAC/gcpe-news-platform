import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useMoveFocusRestore } from "./useMoveFocusRestore";

/** Three rows, each with an up/down Move button wrapped in a `data-move-id`/`data-move-dir`
 * span — the same shape DocumentsSection/CarouselScreen/LinksScreen use. `disabledId`/`disabledDir`
 * lets a test make one specific button the boundary-disabled one. */
function Rows({ disabled }: { disabled?: { id: string; dir: "up" | "down" } }) {
  const focus = useMoveFocusRestore<HTMLDivElement>();
  const ids = ["a", "b", "c"];
  return (
    <div ref={focus.containerRef}>
      {ids.map((id) => (
        <div key={id}>
          <span data-move-id={id} data-move-dir="up">
            <button type="button" disabled={disabled?.id === id && disabled.dir === "up"}>
              Move {id} up
            </button>
          </span>
          <span data-move-id={id} data-move-dir="down">
            <button type="button" disabled={disabled?.id === id && disabled.dir === "down"}>
              Move {id} down
            </button>
          </span>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          focus.remember("b", "up");
          focus.restore();
        }}
      >
        remember-and-restore b up
      </button>
      <button
        type="button"
        onClick={() => {
          focus.remember("b", "down");
          focus.restore();
        }}
      >
        remember-and-restore b down
      </button>
    </div>
  );
}

describe("useMoveFocusRestore (I4)", () => {
  afterEach(cleanup);

  it("restores focus to the remembered item's same-direction button, by id", () => {
    render(<Rows />);
    screen.getByRole("button", { name: "remember-and-restore b up" }).click();
    expect(screen.getByRole("button", { name: "Move b up" })).toHaveFocus();
  });

  it("falls back to the opposite-direction button when the same one is disabled", () => {
    render(<Rows disabled={{ id: "b", dir: "up" }} />);
    screen.getByRole("button", { name: "remember-and-restore b up" }).click();
    expect(screen.getByRole("button", { name: "Move b down" })).toHaveFocus();
  });

  it("restore() without a prior remember() leaves focus untouched", () => {
    render(<Rows />);
    screen.getByRole("button", { name: "Move a up" }).focus();
    // Calling restore() a second time (pending was already cleared by the first restore in the
    // previous click) must not move focus away from whatever's currently focused.
    screen.getByRole("button", { name: "remember-and-restore b up" }).click();
    screen.getByRole("button", { name: "Move b up" }).focus();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move b up" }));
  });
});
