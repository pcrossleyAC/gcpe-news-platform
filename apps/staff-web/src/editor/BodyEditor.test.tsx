import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BodyEditor } from "./BodyEditor";
import { caretToEnd } from "../../test/editorCaret";

/** Pastes through ProseMirror's own paste path (transformPastedHTML included). jsdom has no
 * ClipboardEvent, which view.pasteHTML constructs, so a plain Event stands in. */
function pasteHtml(field: HTMLElement, html: string): void {
  if (typeof globalThis.ClipboardEvent === "undefined") vi.stubGlobal("ClipboardEvent", class extends Event {});
  (field as unknown as { editor: { view: { pasteHTML(html: string): boolean } } }).editor.view.pasteHTML(html);
}

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

  it("does not call onChange on mount, even when TipTap rewrites the given HTML", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value={"<p>a</p>\r\n<p>b <b>c</b></p>"} onChange={onChange} readOnly={false} />);
    await screen.findByRole("textbox", { name: "Body" });
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allowAssets={false} shows no Insert asset button; default still does", async () => {
    render(<BodyEditor id="bio" label="Biography" value="<p></p>" onChange={() => {}} readOnly={false} allowAssets={false} />);
    await screen.findByRole("textbox", { name: "Biography" });
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert asset" })).toBeNull();
    cleanup();
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={() => {}} readOnly={false} />);
    await screen.findByRole("textbox", { name: "Body" });
    expect(screen.getByRole("button", { name: "Insert asset" })).toBeInTheDocument();
  });

  it("describedBy sets the editing area's accessible description, and follows changes", async () => {
    const { rerender } = render(
      <>
        <p id="hint">Hint text.</p>
        <p id="note">A note.</p>
        <BodyEditor id="bio" label="Biography" value="<p></p>" onChange={() => {}} readOnly={false} describedBy="hint" />
      </>,
    );
    const field = await screen.findByRole("textbox", { name: "Biography" });
    expect(field).toHaveAccessibleDescription("Hint text.");
    rerender(
      <>
        <p id="hint">Hint text.</p>
        <p id="note">A note.</p>
        <BodyEditor id="bio" label="Biography" value="<p></p>" onChange={() => {}} readOnly={false} describedBy="hint note" />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Biography" })).toHaveAccessibleDescription("Hint text. A note."));
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

  it("allowAssets={false}: no asset node — a stored or pasted <asset> becomes its URL as text (what Core stores), paste reduced to BIO_TAGS", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="bio" label="Biography" value="<p>a</p><asset>https://youtu.be/stored00001</asset>" onChange={onChange} readOnly={false} allowAssets={false} />);
    const field = await screen.findByRole("textbox", { name: "Biography" });
    expect(field.querySelector(".gcpe-body-editor__asset-chip")).toBeNull();
    expect(field.textContent).toContain("https://youtu.be/stored00001");
    pasteHtml(field, "<asset>https://youtu.be/pasted00001</asset><h2>Heading</h2>");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as string;
    expect(last).not.toContain("<asset");
    expect(last).not.toContain("<h2");
    expect(last).toContain("https://youtu.be/pasted00001");
    expect(last).toContain("Heading");
  });

  it("with allowItalic, the toolbar has an Italic toggle and toggling it wraps the selection in <em>", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={onChange} readOnly={false} allowItalic />);
    const field = await screen.findByLabelText("Body");
    const user = userEvent.setup();
    const italic = screen.getByRole("button", { name: "Italic" });
    expect(italic).toHaveAttribute("aria-pressed", "false");
    await user.click(italic);
    await user.click(field);
    await user.type(field, "hi");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain("<em>hi</em>");
    await waitFor(() => expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("with allowItalic, stored '<p>under the <i>FOIPP Act</i></p>' loads italic and an edit elsewhere keeps '<em>FOIPP Act</em>'", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p>under the <i>FOIPP Act</i></p>" onChange={onChange} readOnly={false} allowItalic />);
    const field = await screen.findByLabelText("Body");
    expect(field.querySelector("em")?.textContent).toBe("FOIPP Act");
    const user = userEvent.setup();
    await user.click(field);
    (field as unknown as { editor: { commands: { focus(p: string): void } } }).editor.commands.focus("start");
    await user.type(field, "x", { skipClick: true });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toBe("<p>xunder the <em>FOIPP Act</em></p>");
  });

  it("without allowItalic there is no Italic button and the release schema has no italic mark", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p>a <em>b</em></p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByLabelText("Body");
    expect(screen.queryByRole("button", { name: "Italic" })).not.toBeInTheDocument();
    expect(field.querySelector("em")).toBeNull();
    const { bodyExtensions } = await import("./schema");
    expect(bodyExtensions().some((e) => e.name === "italic")).toBe(false);
    expect(bodyExtensions(null, { italic: true }).some((e) => e.name === "italic")).toBe(true);
  });

  it("without allowItalic, a pasted <i>/<em> stores no <em> and keeps the text", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByRole("textbox", { name: "Body" });
    pasteHtml(field, "<p><i>a</i> <em>b</em></p>");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as string;
    expect(last).not.toContain("<em>");
    expect(last).toContain("a b");
  });

  it.each([
    ["Italic", "<p>a <em>b</em> c</p>"],
    ["Bold", "<p>a <strong>b</strong> c</p>"],
  ])("the %s toggle's aria-pressed follows the caret in and out of the formatting", async (name, html) => {
    render(<BodyEditor id="body" label="Body" value={html} onChange={() => {}} readOnly={false} allowItalic />);
    const field = await screen.findByLabelText("Body");
    const editor = (field as unknown as { editor: { commands: { setTextSelection(p: number): void } } }).editor;
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("aria-pressed", "false");
    act(() => editor.commands.setTextSelection(4)); // inside "b" (doc: p@0, "a " = 1-2, b = 3-4)
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    act(() => editor.commands.setTextSelection(6)); // in " c"
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
  });

  it("allowAssets default: a pasted <asset> stays an asset embed", async () => {
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p></p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByRole("textbox", { name: "Body" });
    pasteHtml(field, "<asset>https://youtu.be/pasted00002</asset>");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain("<asset>https://youtu.be/pasted00002</asset>");
  });
  // Review P3: an untouched release editor form re-seeds when the release changes underneath it
  // (useSeededForm). If the body has focus at that moment the new value must still land — or
  // the next keystroke would send the old text back over it.
  it("a new value arriving while the editor has focus (and holds no unsent edits) replaces the content, so the next keystroke builds on it", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<BodyEditor id="body" label="Body" value="<p>Old text</p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByLabelText("Body");
    const user = userEvent.setup();
    await user.click(field);
    expect(field).toHaveFocus();

    rerender(<BodyEditor id="body" label="Body" value="<p>New text</p>" onChange={onChange} readOnly={false} />);
    await waitFor(() => expect(field).toHaveTextContent("New text"));
    expect(onChange).not.toHaveBeenCalled();

    caretToEnd(field);
    await user.type(field, "!", { skipClick: true });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as string;
    expect(last).toContain("New text");
    expect(last).not.toContain("Old text");
  });

  it("caretToEnd holds on a slow runner: typing after stored text appends, even when ProseMirror's post-focus timer runs first", async () => {
    // The Windows CI failure ("<p>yzx</p>"), made deterministic. On a slow runner, ProseMirror's
    // 20ms post-focus timer (armed by the click) can run before the selectionchange event (a
    // setImmediate in jsdom) for a caret move made just after the click. Holding that timer back
    // and running it straight after caretToEnd forces that order. See test/editorCaret.ts.
    const onChange = vi.fn();
    render(<BodyEditor id="body" label="Body" value="<p>x</p>" onChange={onChange} readOnly={false} />);
    const field = await screen.findByLabelText("Body");
    const user = userEvent.setup();
    const held: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 20) {
        held.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);
    try {
      await user.click(field);
    } finally {
      spy.mockRestore();
    }
    expect(held).toHaveLength(1);
    caretToEnd(field);
    held.forEach((fn) => fn());
    await user.type(field, "yz", { skipClick: true });
    expect(onChange.mock.calls.at(-1)![0]).toBe("<p>xyz</p>");
  });
});

