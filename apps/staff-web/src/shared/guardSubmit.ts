/**
 * Stops a form's onSubmit from firing a second time while the previous submit from that same
 * form is still in flight.
 *
 * A pending submit Button turns into `type="button"` (so its own click can't fire while
 * pending), but that also leaves the form with no submit button. In a form with exactly one
 * text field, pressing Enter again still submits the form natively (HTML implicit submission),
 * so the busy flag has to be checked in onSubmit itself, not just on the button.
 *
 * Call this first, before anything else in the handler: it always prevents the browser's
 * default submit, and tells the caller whether to stop there.
 */
export function ignoreWhileBusy(busy: boolean, e: { preventDefault(): void }): boolean {
  e.preventDefault();
  return busy;
}
