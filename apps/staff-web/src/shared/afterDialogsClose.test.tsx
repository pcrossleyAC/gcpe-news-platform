import { afterEach, describe, expect, it, vi } from "vitest";
import { afterDialogsClose } from "./afterDialogsClose";

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("afterDialogsClose", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("waits while a dialog (or one still animating out) is on the page, then runs", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    document.body.append(dialog);
    const then = vi.fn();
    afterDialogsClose(then);
    await frame();
    await frame();
    expect(then).not.toHaveBeenCalled();
    dialog.removeAttribute("role");
    dialog.setAttribute("data-exiting", "true");
    await frame();
    await frame();
    expect(then).not.toHaveBeenCalled();
    dialog.remove();
    await frame();
    await frame();
    expect(then).toHaveBeenCalledTimes(1);
  });

  it("runs on the next frame when no dialog is open", async () => {
    const then = vi.fn();
    afterDialogsClose(then);
    await frame();
    await frame();
    expect(then).toHaveBeenCalledTimes(1);
  });
});
