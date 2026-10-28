import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DirectoryContact } from "@gcpe/site-settings";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { DirectoryContactsEditor } from "./DirectoryContactsEditor";

const A: DirectoryContact = { group: "Health", groupUrl: "", subgroup: "", name: "Ann", phone: "250 555 0101", cell: "", email: "ann@gov.bc.ca", placement: "top" };
const B: DirectoryContact = { ...A, group: "Finance", name: "Bob", placement: "bottom" };

function setup(value: DirectoryContact[], extra: { errors?: { field: string; message: string }[]; disabled?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <AnnouncerProvider>
      <DirectoryContactsEditor value={value} onChange={onChange} errors={extra.errors ?? []} pathPrefix="contactsPage.contacts" disabled={extra.disabled} />
    </AnnouncerProvider>,
  );
  return onChange;
}

describe("DirectoryContactsEditor", () => {
  afterEach(cleanup);

  it("shows one 'Contact n' group per row with typed phone and email fields and the placement choice", () => {
    setup([A, B]);
    const second = screen.getByRole("group", { name: "Contact 2" });
    expect(within(second).getByLabelText("Name")).toHaveValue("Bob");
    expect(within(second).getByLabelText("Phone")).toHaveAttribute("type", "tel");
    expect(within(second).getByLabelText("Cell")).toHaveAttribute("type", "tel");
    expect(within(second).getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(within(second).getByRole("radio", { name: "Below the ministries" })).toBeChecked();
    expect(screen.getByText("Ministry contacts come from each ministry’s Organizations form.")).toBeInTheDocument();
  });

  it("edits a field, changes placement, moves, removes and adds a blank top row", async () => {
    const onChange = setup([A, B]);
    const user = userEvent.setup();
    await user.type(within(screen.getByRole("group", { name: "Contact 1" })).getByLabelText("Cell"), "7");
    expect(onChange).toHaveBeenLastCalledWith([{ ...A, cell: "7" }, B]);
    await user.click(within(screen.getByRole("group", { name: "Contact 1" })).getByRole("radio", { name: "Below the ministries" }));
    expect(onChange).toHaveBeenLastCalledWith([{ ...A, placement: "bottom" }, B]);
    await user.click(screen.getByRole("button", { name: "Move contact 1 down" }));
    expect(onChange).toHaveBeenLastCalledWith([B, A]);
    await user.click(screen.getByRole("button", { name: "Remove contact 1" }));
    expect(onChange).toHaveBeenLastCalledWith([B]);
    await user.click(screen.getByRole("button", { name: "Add contact" }));
    expect(onChange).toHaveBeenLastCalledWith([A, B, { group: "", groupUrl: "", subgroup: "", name: "", phone: "", cell: "", email: "", placement: "top" }]);
  });

  it("puts an error beside its own row's field", () => {
    setup([A, B], { errors: [{ field: "contactsPage.contacts[1].email", message: "Enter an email address like name@gov.bc.ca." }] });
    expect(within(screen.getByRole("group", { name: "Contact 2" })).getByText("Enter an email address like name@gov.bc.ca.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Contact 1" })).queryByText(/Enter an email/)).toBeNull();
  });

  it("disabled: fields are disabled and no buttons show", () => {
    setup([A], { disabled: true });
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
