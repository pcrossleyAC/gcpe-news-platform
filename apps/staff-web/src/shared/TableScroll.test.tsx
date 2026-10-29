import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TableScroll } from "./TableScroll";

function stubWidths(scrollWidth: number, clientWidth: number): () => void {
  const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
  return () => {
    if (sw) Object.defineProperty(HTMLElement.prototype, "scrollWidth", sw);
    if (cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", cw);
  };
}

const table = (
  <table aria-label="Members">
    <tbody>
      <tr>
        <td>a</td>
      </tr>
    </tbody>
  </table>
);

describe("TableScroll", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    cleanup();
  });

  it("names the region apart from the table it holds", () => {
    render(<TableScroll label="Members">{table}</TableScroll>);
    expect(screen.getByRole("region", { name: "Members — scrollable" })).toContainElement(screen.getByRole("table", { name: "Members" }));
  });

  it("is no tab stop while the table fits", () => {
    restore = stubWidths(600, 600);
    render(<TableScroll label="Members">{table}</TableScroll>);
    expect(screen.getByRole("region")).not.toHaveAttribute("tabindex");
  });

  it("is a tab stop while the table is wider than its box", () => {
    restore = stubWidths(1200, 600);
    render(<TableScroll label="Members">{table}</TableScroll>);
    expect(screen.getByRole("region")).toHaveAttribute("tabindex", "0");
  });
});
