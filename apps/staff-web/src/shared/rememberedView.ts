/**
 * A per-user, per-browser memory of how a screen was last viewed (a list's filter, say), in
 * localStorage. It is only a convenience: storage that's blocked, full or cleared (a private
 * window, a locked-down browser) just means the screen opens with its defaults. Nothing here is
 * ever sent anywhere, and it never holds what someone typed into a search box.
 */
const keyOf = (userId: string, view: string) => `gcpe.hub.view.${view}.${userId}`;

export function readRememberedView(userId: string | undefined, view: string): string | null {
  if (!userId) return null;
  try {
    return window.localStorage.getItem(keyOf(userId, view));
  } catch {
    return null;
  }
}

export function rememberView(userId: string | undefined, view: string, value: string | null): void {
  if (!userId) return;
  try {
    if (value === null) window.localStorage.removeItem(keyOf(userId, view));
    else window.localStorage.setItem(keyOf(userId, view), value);
  } catch {
    // Not remembered; the screen still works.
  }
}
