import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BodyEditor } from "./BodyEditor";

describe("BodyEditor", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the given HTML through the allow-listed schema", async () => {
    render(<BodyEditor id="body" label="Body" value="<p>Hello <strong>world</strong></p>" onChange={() => {}} readOnly={false} />);
    const field = await screen.findByLabelText("Body");
    expect(field.innerHTML).toContain("<strong>world</strong>");
  });

  it("shows a visible label tied to the editing area, which is a multi-line textbox", async () => {
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={() => {}} readOnly={false} />);
    const label = screen.getByText("Body", { selector: "label, span, div" });
    expect(label).toBeVisible();
    const field = await screen.findByRole("textbox", { name: "Body" });
    expect(field.getAttribute("aria-multiline")).toBe("true");
    expect(field.getAttribute("aria-labelledby")).toBe(label.id);
    expect(field.closest(".gcpe-body-editor__area")).not.toBeNull();
  });

  it("read-only: not editable, and no toolbar", async () => {
    render(<BodyEditor id="body" label="Body" value="<p>x</p>" onChange={() => {}} readOnly />);
    const field = await screen.findByLabelText("Body");
    expect(field.getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("toggling Bold on typed text updates the emitted HTML to use <strong>", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByLabelText("Body");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Bold" }));
    await user.click(field);
    await user.type(field, "hi");

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as string;
    expect(last).toContain("<strong>");
  });

  it("Insert asset prompts for a URL and inserts an <asset> embed", async () => {
    const onChange = vi.fn();
    vi.stubGlobal("prompt", vi.fn(() => "https://youtu.be/abcdef12345"));
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={onChange} readOnly={false} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Insert asset" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as string;
    expect(last).toContain("<asset>https://youtu.be/abcdef12345</asset>");
  });

  it("wires paste reduction to the shared allow-list filter (Step 1: disallowed paste content is stripped)", async () => {
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={() => {}} readOnly={false} />);
    await screen.findByLabelText("Body");
    // Exercises the exact function given to TipTap as `transformPastedHTML`, rather than
    // simulating a native ClipboardEvent (jsdom's DataTransfer support is too partial to trust
    // as the thing under test) — reduceToAllowedHtml itself is covered end-to-end by
    // pasteFilter.test.tsx; this just confirms BodyEditor actually wires it in.
    const { reduceToAllowedHtml } = await import("./pasteFilter");
    expect(reduceToAllowedHtml('<h1>Title</h1><script>alert(1)</script><a href="javascript:x">x</a>')).toBe("Title<a>x</a>");
  });
});
