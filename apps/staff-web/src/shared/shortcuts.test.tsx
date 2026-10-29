import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./BusyButton";
import { ariaKeyShortcuts, isApplePlatform, matchesShortcut, SHORTCUTS, shortcutText, shortcutWords, useFormShortcut, useShortcut, type ShortcutId } from "./shortcuts";

/** jsdom's navigator.platform is "" — not an Apple device — so Ctrl is the modifier here. */
const ctrl = (key: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key, ctrlKey: true, ...extra });

function Screen({ id = "save", run }: { id?: ShortcutId; run: () => void }): React.JSX.Element {
  useShortcut(id, run);
  return <input aria-label="field" />;
}

describe("the shortcut registry", () => {
  afterEach(() => cleanup());

  it("every shortcut that acts takes a modifier (WCAG 2.1.4: no single-character shortcuts)", () => {
    for (const s of SHORTCUTS) {
      if (s.id === "escape") continue;
      expect(s.modifier).toBe(true);
    }
  });

  it("names keys for the platform: ⌘ on Apple devices, Ctrl elsewhere", () => {
    expect(shortcutText("save", true)).toBe("⌘S");
    expect(shortcutText("save", false)).toBe("Ctrl+S");
    expect(shortcutText("submit", true)).toBe("⌘↩");
    expect(shortcutText("submit", false)).toBe("Ctrl+Enter");
    expect(shortcutWords("search", true)).toBe("Command+K");
    expect(ariaKeyShortcuts("save", true)).toBe("Meta+S");
    expect(ariaKeyShortcuts("submit", false)).toBe("Control+Enter");
  });

  it("detects Apple devices from userAgentData, then navigator.platform", () => {
    expect(isApplePlatform({ userAgentData: { platform: "macOS" }, platform: "" } as unknown as Navigator)).toBe(true);
    expect(isApplePlatform({ platform: "MacIntel" } as Navigator)).toBe(true);
    expect(isApplePlatform({ platform: "iPad" } as Navigator)).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: "Windows" }, platform: "Win32" } as unknown as Navigator)).toBe(false);
  });

  it("matches only the command modifier: not with Shift or Alt, and on Apple devices not Ctrl", () => {
    expect(matchesShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, "save", false)).toBe(true);
    expect(matchesShortcut({ key: "S", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "save", false)).toBe(false);
    expect(matchesShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, "save", false)).toBe(false);
    expect(matchesShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, "save", true)).toBe(false);
    expect(matchesShortcut({ key: "s", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "save", true)).toBe(true);
    expect(matchesShortcut({ key: "s", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, "save", false)).toBe(false);
  });
});

describe("useShortcut", () => {
  afterEach(() => cleanup());

  it("runs the screen's action and prevents the browser's own (Save page) — even from inside a text field", () => {
    const run = vi.fn();
    render(<Screen run={run} />);
    screen.getByLabelText("field").focus();
    const notCancelled = ctrl("s");
    expect(run).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  it("leaves the browser's own behaviour alone on a screen without the action", () => {
    render(<Screen id="search" run={() => {}} />);
    expect(ctrl("s")).toBe(true);
  });

  it("does nothing while an IME composition is under way, or for a held-down repeat", () => {
    const run = vi.fn();
    render(<Screen run={run} />);
    ctrl("s", { isComposing: true });
    ctrl("Process", { keyCode: 229 });
    ctrl("s", { repeat: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing for a key the focused control already handled (preventDefault), such as the editor's own ⌘/Ctrl+Enter", () => {
    const run = vi.fn();
    function Editor(): React.JSX.Element {
      useShortcut("submit", run);
      return <div aria-label="editor" tabIndex={0} onKeyDown={(e) => e.preventDefault()} />;
    }
    render(<Editor />);
    screen.getByLabelText("editor").focus();
    ctrl("Enter");
    expect(run).not.toHaveBeenCalled();
  });

  it("go-to-search never acts from inside a rich text (contenteditable) field", () => {
    const run = vi.fn();
    function WithEditor(): React.JSX.Element {
      useShortcut("search", run);
      return <div aria-label="editor" contentEditable suppressContentEditableWarning tabIndex={0} />;
    }
    render(<WithEditor />);
    const editor = screen.getByLabelText("editor");
    Object.defineProperty(editor, "isContentEditable", { value: true });
    editor.focus();
    expect(ctrl("k")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("a scoped Save (a row's own) acts while focus is inside it; the screen-wide one otherwise", () => {
    const row = vi.fn();
    const page = vi.fn();
    function Page(): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      useShortcut("save", page);
      useShortcut("save", row, { within: ref });
      return (
        <>
          <input aria-label="outside" />
          <div ref={ref}>
            <input aria-label="inside" />
          </div>
        </>
      );
    }
    render(<Page />);
    screen.getByLabelText("inside").focus();
    ctrl("s");
    expect(row).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    screen.getByLabelText("outside").focus();
    ctrl("s");
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("with only scoped Saves and focus in none of them, nothing is saved (but the browser's Save page is still kept away)", () => {
    const row = vi.fn();
    function Page(): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      useShortcut("save", row, { within: ref });
      return (
        <>
          <input aria-label="outside" />
          <div ref={ref} />
        </>
      );
    }
    render(<Page />);
    screen.getByLabelText("outside").focus();
    expect(ctrl("s")).toBe(false);
    expect(row).not.toHaveBeenCalled();
  });

  it("with focus in a dialog, the page behind it doesn't act", () => {
    const run = vi.fn();
    function Page(): React.JSX.Element {
      useShortcut("save", run);
      return (
        <div role="dialog" aria-label="Publish">
          <button>Cancel</button>
        </div>
      );
    }
    render(<Page />);
    screen.getByRole("button", { name: "Cancel" }).focus();
    ctrl("s");
    expect(run).not.toHaveBeenCalled();
  });

  it("stops acting once the screen unmounts", () => {
    const run = vi.fn();
    const { unmount } = render(<Screen run={run} />);
    unmount();
    expect(ctrl("s")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("useFormShortcut submits the form as its submit button would", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    function Form(): React.JSX.Element {
      const ref = useFormShortcut("save", true);
      return (
        <form ref={ref} onSubmit={onSubmit}>
          <input aria-label="name" />
          <button type="submit">Save</button>
        </form>
      );
    }
    render(<Form />);
    screen.getByLabelText("name").focus();
    ctrl("s");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("a button's shortcut hint", () => {
  afterEach(() => cleanup());

  it("shows the keys, keeps them out of the button's name, and sets aria-keyshortcuts", () => {
    render(<Button shortcut="save">Save changes</Button>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+S");
    expect(button).toHaveTextContent("Save changesCtrl+S");
  });

  it("a pending button shows its pending label alone", () => {
    render(
      <Button shortcut="save" isPending pendingLabel="Saving…">
        Save changes
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveTextContent(/^Saving…$/);
  });
});
