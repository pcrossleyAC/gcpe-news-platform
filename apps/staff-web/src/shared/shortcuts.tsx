import { useEffect, useRef, type RefObject } from "react";

/**
 * The Hub's keyboard shortcuts, in one place (owner decision 2026-10-29): the key handlers
 * ({@link useShortcut}), the hints on buttons ({@link ShortcutHint}, `aria-keyshortcuts`) and the
 * Help page all read this list, so they can't drift apart.
 *
 * Every shortcut that acts takes the platform's command modifier (⌘ on Apple devices, Ctrl
 * elsewhere): no single-character shortcuts (WCAG 2.1.4). Ctrl+S, Ctrl+Enter and Ctrl+K are not
 * used by NVDA or JAWS (their own commands use Insert or Caps Lock) or by VoiceOver (Control+Option),
 * and the browser's own Save page / search bar is only overridden on screens that have the action.
 */
export type ShortcutId = "save" | "submit" | "search";

export interface ShortcutDef {
  id: ShortcutId | "escape";
  /** `KeyboardEvent.key` (case-insensitive). */
  key: string;
  /** Pressed with the platform's command modifier. Escape alone is the browser's and dialogs' own. */
  modifier: boolean;
  /** What it does, as the Help page lists it. */
  does: string;
  /** Where it works, as the Help page lists it. */
  where: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: "save",
    key: "s",
    modifier: true,
    does: "Save your changes",
    where:
      "Screens with a Save: the release editor (it saves every changed section), an activity, the Website settings screens (Save draft — never Publish), the next carousel, emergency pins, resource links, Live Feed, Sectors, themes and tags, release page titles, media list names, Government terms, organizations, Calendar access, Calendar users and lookups, a user's name or roles, a subscriber's preferences and Subscribers operations. Where a screen has a Save for each row or form, it saves the one you're in."
  },
  {
    id: "submit",
    key: "Enter",
    modifier: true,
    does: "Create — the form's main button",
    where: "New release and New activity. In a dialog, Enter and Esc work as usual instead.",
  },
  {
    id: "search",
    key: "k",
    modifier: true,
    does: "Go to the search or filter box",
    where: "Release lists (the Type filter), Search, the Calendar list (opens Filters), Subscribers and Users. On other screens, Find a release in the side menu (for anyone with Releases).",
  },
  {
    id: "escape",
    key: "Escape",
    modifier: false,
    does: "Close a dialog, or the open panel or menu you're in",
    where: "Everywhere. Focus goes back to the button that opened it.",
  },
];

const defOf = (id: ShortcutDef["id"]): ShortcutDef => SHORTCUTS.find((s) => s.id === id)!;

/** Apple devices use ⌘ (Meta) where others use Ctrl. */
export function isApplePlatform(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav) return false;
  const platform = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const keyName = (key: string, apple: boolean): string => {
  if (key === "Enter") return apple ? "Return" : "Enter";
  if (key === "Escape") return "Esc";
  return key.toUpperCase();
};

/** The hint text on a button: "⌘S" on Apple devices, "Ctrl+S" elsewhere. */
export function shortcutText(id: ShortcutDef["id"], apple = isApplePlatform()): string {
  const def = defOf(id);
  if (!def.modifier) return keyName(def.key, apple);
  return apple ? `⌘${def.key === "Enter" ? "↩" : keyName(def.key, apple)}` : `Ctrl+${keyName(def.key, apple)}`;
}

/** The keys spelled out, for the Help page: "Command+S" / "Ctrl+S". */
export function shortcutWords(id: ShortcutDef["id"], apple = isApplePlatform()): string {
  const def = defOf(id);
  if (!def.modifier) return keyName(def.key, apple);
  return `${apple ? "Command" : "Ctrl"}+${keyName(def.key, apple)}`;
}

/** `aria-keyshortcuts` for a button the shortcut presses: "Meta+S" / "Control+S". */
export function ariaKeyShortcuts(id: ShortcutDef["id"], apple = isApplePlatform()): string {
  const def = defOf(id);
  const key = def.key.length === 1 ? def.key.toUpperCase() : def.key;
  return def.modifier ? `${apple ? "Meta" : "Control"}+${key}` : key;
}

/** Does this keydown press the shortcut? The command modifier alone (no Shift or Alt, and on Apple
 * devices not Ctrl, which is a different key there). */
export function matchesShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, id: ShortcutId, apple = isApplePlatform()): boolean {
  const def = defOf(id);
  const modifier = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return modifier && !e.altKey && !e.shiftKey && e.key.toLowerCase() === def.key.toLowerCase();
}

interface Registration {
  id: ShortcutId;
  run: () => void;
  /** go-to-search: the box it goes to, which carries the key hint while this registration wins. */
  inputId?: string;
  /** Acts only when no other screen-wide registration does, whenever either mounted (the shell's
   * Find a release, behind any screen's own search box). */
  fallback?: boolean;
  within?: RefObject<HTMLElement | null>;
  order: number;
}

const registrations = new Set<Registration>();

/** The registration a key acts on when focus is in none of the scoped ones: the latest screen-wide one. */
const screenWide = (candidates: Registration[]): Registration | undefined =>
  candidates.filter((r) => !r.within).sort((a, b) => Number(Boolean(a.fallback)) - Number(Boolean(b.fallback)) || b.order - a.order)[0];

/**
 * Only the box ⌘/Ctrl+K actually goes to says so (`aria-keyshortcuts`): the screen's own search or
 * filter box when it has one, the side menu's Find a release otherwise — never both.
 */
function syncSearchHints(): void {
  const searches = [...registrations].filter((r) => r.id === "search" && r.inputId);
  const winner = screenWide(searches);
  for (const r of searches) {
    const el = document.getElementById(r.inputId!);
    if (!el) continue;
    if (r === winner) el.setAttribute("aria-keyshortcuts", ariaKeyShortcuts("search"));
    else el.removeAttribute("aria-keyshortcuts");
  }
}
let nextOrder = 0;
let listening = false;

const inDialog = (el: Element | null) => el?.closest('[role="dialog"], [role="alertdialog"]') ?? null;

/**
 * The one keydown listener. A shortcut acts only on a screen that registered it — there the
 * browser's own meaning (Save page, its search bar) is prevented — and:
 *  - never during an IME composition, nor for a key the focused control already handled (the
 *    rich text editor's own ⌘/Ctrl+Enter line break, for one);
 *  - "go to search" never from inside the rich text editor;
 *  - a registration scoped to part of the page (a row's or a form's own Save) wins when focus is
 *    inside that part; otherwise the screen-wide one (the latest, if several) acts;
 *  - with focus in a dialog, nothing behind the dialog acts (its own buttons keep Enter and Esc).
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  const apple = isApplePlatform();
  const id = (["save", "submit", "search"] as const).find((s) => matchesShortcut(e, s, apple));
  if (!id) return;
  const candidates = [...registrations].filter((r) => r.id === id);
  if (candidates.length === 0) return;
  const active = document.activeElement;
  if (id === "search" && active instanceof HTMLElement && active.isContentEditable) return;
  const scoped = candidates.filter((r) => r.within?.current && active && r.within.current.contains(active));
  // The innermost scope: one that contains no other matching scope.
  const pick =
    scoped.find((r) => !scoped.some((o) => o !== r && r.within!.current!.contains(o.within!.current!))) ??
    screenWide(candidates);
  // With focus in a dialog, nothing behind it acts. Cmd/Ctrl+K is left to the dialog and the
  // browser; Save and Submit are still kept from the browser, as before.
  const dialog = inDialog(active);
  if (dialog && !(pick?.within?.current && dialog.contains(pick.within.current))) {
    if (id !== "search") e.preventDefault();
    return;
  }
  // Otherwise the browser's own meaning is kept away even when nothing here acts (only scoped
  // Saves, focus in none of them): Save page never opens on a screen that has a Save.
  e.preventDefault();
  if (e.repeat || !pick) return;
  pick.run();
}

/**
 * Makes `id` do `run` while this component is mounted (pass null to leave it off, e.g. read-only).
 * `within` scopes it to an element: it acts only while focus is inside (a row's or a form's own
 * Save, on a screen with several).
 */
export function useShortcut(id: ShortcutId, run: (() => void) | null | false | undefined, options: { within?: RefObject<HTMLElement | null>; inputId?: string; fallback?: boolean } = {}): void {
  const runRef = useRef(run);
  runRef.current = run;
  const enabled = Boolean(run);
  const { within, inputId, fallback } = options;
  useEffect(() => {
    if (!enabled) return;
    const registration: Registration = { id, run: () => runRef.current && runRef.current(), within, inputId, fallback, order: ++nextOrder };
    registrations.add(registration);
    if (!listening) {
      document.addEventListener("keydown", onKeyDown);
      listening = true;
    }
    if (inputId) syncSearchHints();
    return () => {
      registrations.delete(registration);
      if (inputId) {
        document.getElementById(inputId)?.removeAttribute("aria-keyshortcuts");
        syncSearchHints();
      }
    };
  }, [id, enabled, within, inputId, fallback]);
}

/**
 * ⌘/Ctrl+S (or another shortcut) submits this form, as its submit button would: returns the ref to
 * put on the `<form>`. `scoped` limits it to while focus is inside the form (a screen with several).
 */
export function useFormShortcut(id: ShortcutId, enabled: boolean, scoped = false): RefObject<HTMLFormElement | null> {
  const form = useRef<HTMLFormElement | null>(null);
  useShortcut(id, enabled ? () => form.current?.requestSubmit() : null, scoped ? { within: form } : {});
  return form;
}

/**
 * ⌘/Ctrl+K moves focus to this screen's search or filter box (the element with `inputId`), and
 * marks the box with `aria-keyshortcuts` while it is the one the key goes to. `reveal` runs first, synchronously — to open a closed
 * panel the box sits in.
 */
export function useSearchShortcut(inputId: string, reveal?: () => void, options: { fallback?: boolean } = {}): void {
  useShortcut(
    "search",
    () => {
      reveal?.();
      const input = document.getElementById(inputId);
      input?.focus();
      if (input instanceof HTMLInputElement && input.type !== "number") input.select();
    },
    { inputId, fallback: options.fallback },
  );
  // Every render: the box may only now be on the page (rendered once data has loaded).
  useEffect(() => syncSearchHints());
}

/** The subtle key hint inside a button ("⌘S" / "Ctrl+S"). Hidden from assistive technology: the
 * button's `aria-keyshortcuts` says it instead, and it isn't part of the button's name. Hidden on
 * touch screens, where there's no keyboard to press it on (styles/global.css). */
export function ShortcutHint({ id }: { id: ShortcutDef["id"] }): React.JSX.Element {
  return (
    <kbd className="gcpe-shortcut-hint" aria-hidden="true">
      {shortcutText(id)}
    </kbd>
  );
}
