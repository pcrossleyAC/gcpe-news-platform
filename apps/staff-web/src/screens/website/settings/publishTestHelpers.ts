import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * W4: Publish on a settings screen asks first. Chooses Publish, then the dialog's own Publish
 * (or "Publish all changes" when the draft also covers other screens).
 */
export async function publishAndConfirm(user: UserEvent, publish: HTMLElement): Promise<void> {
  await user.click(publish);
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /^Publish( all changes)?$/ }));
}
