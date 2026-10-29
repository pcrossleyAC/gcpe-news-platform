/**
 * Runs `then` once no dialog is on screen any more. While a design-system Modal is open, and
 * through its short exit animation after it is told to close, React Aria hides the rest of the
 * page from assistive technology (aria-hidden), so a live region outside the dialog that changes
 * then is never announced. A result shown after a confirmation dialog ("Saved" next to the
 * control) waits for this instead. Gives up waiting after `maxMs` and runs anyway.
 */
export function afterDialogsClose(then: () => void, maxMs = 2000): void {
  const started = Date.now();
  const open = () => document.querySelector('[role="alertdialog"], [role="dialog"], [data-exiting]') !== null;
  const check = () => {
    if (!open() || Date.now() - started > maxMs) then();
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}
