import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FieldError, LinkSetting } from "@gcpe/site-settings";
import { AnnouncerProvider } from "./Announcer";
import { LinkListEditor, withoutBlankLinks } from "./LinkListEditor";

let latest: LinkSetting[] = [];

function Harness({ initial, errors = [], reorderable = true, withSummary = false, disabled = false }: { initial: LinkSetting[]; errors?: FieldError[]; reorderable?: boolean; withSummary?: boolean; disabled?: boolean }) {
  const [links, setLinks] = useState(initial);
  latest = links;
  return (
    <AnnouncerProvider>
      <LinkListEditor legend="Help links" links={links} onChange={setLinks} errors={errors} pathPrefix="footer.helpLinks" reorderable={reorderable} withSummary={withSummary} isDisabled={disabled} />
    </AnnouncerProvider>
  );
}

const A: LinkSetting = { id: "footerHome", text: "Home", url: "/" };
const B: LinkSetting = { id: "footerAbout", text: "About", url: "/about", summary: "kept" };

describe("LinkListEditor", () => {
  afterEach(cleanup);

  it("moves a link down, carrying its id and fields it doesn't show, announces it and keeps focus on the moved link", async () => {
    render(<Harness initial={[A, B]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move link 1 down" }));
    expect(latest).toEqual([B, A]);
    expect(screen.getByRole("button", { name: "Move link 2 up" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Link 1 moved to position 2");
  });

  it("a description is shown under the legend and describes the group; without one the group has no description", () => {
    render(
      <AnnouncerProvider>
        <LinkListEditor legend="Team" description="Shown as Meet the Team." links={[]} onChange={() => {}} errors={[]} pathPrefix="teamLinks" reorderable withSummary={false} />
      </AnnouncerProvider>,
    );
    expect(screen.getByRole("group", { name: "Team" })).toHaveAccessibleDescription("Shown as Meet the Team.");
    cleanup();
    render(<Harness initial={[]} />);
    expect(screen.getByRole("group", { name: "Help links" })).not.toHaveAttribute("aria-describedby");
  });

  it("editing a row keeps its id and summary", async () => {
    render(<Harness initial={[B]} />);
    const user = userEvent.setup();
    const row = screen.getByRole("group", { name: "Link 1" });
    await user.type(within(row).getByLabelText("Link text"), " us");
    expect(latest).toEqual([{ id: "footerAbout", text: "About us", url: "/about", summary: "kept" }]);
    expect(within(row).queryByLabelText("Description (optional)")).toBeNull();
  });

  it("adds a row and focuses its link text; removing a row focuses the next one, or Add when none is left", async () => {
    render(<Harness initial={[A]} withSummary />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Add a link" }));
    expect(latest).toEqual([A, { text: "", url: "" }]);
    const row2 = screen.getByRole("group", { name: "Link 2" });
    expect(within(row2).getByLabelText("Link text")).toHaveFocus();
    expect(within(row2).getByLabelText("Description (optional)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(latest).toEqual([{ text: "", url: "" }]);
    expect(within(screen.getByRole("group", { name: "Link 1" })).getByLabelText("Link text")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(latest).toEqual([]);
    expect(screen.getByRole("button", { name: "+ Add a link" })).toHaveFocus();
  });

  it("shows each row's errors on its own fields, by index, and id errors on the row", () => {
    render(
      <Harness
        initial={[A, B]}
        errors={[
          { field: "footer.helpLinks[1].url", message: "Must start with https:// or / (a page on this site)." },
          { field: "footer.helpLinks[0].id", message: "Link id must start with a letter and use only letters, digits, - or _." },
          { field: "footer.helpLinks[10].url", message: "not this list's row 1" },
          { field: "footer.helpLinksExtra[1].url", message: "not this list" },
        ]}
      />,
    );
    const row2 = screen.getByRole("group", { name: "Link 2" });
    expect(within(row2).getByLabelText("Web address")).toHaveAccessibleDescription(expect.stringContaining("Must start with https:// or / (a page on this site)."));
    expect(within(row2).getByLabelText("Link text")).not.toHaveAttribute("aria-invalid");
    const row1 = screen.getByRole("group", { name: "Link 1" });
    expect(within(row1).getByText("Link id must start with a letter and use only letters, digits, - or _.")).toBeInTheDocument();
    expect(screen.queryByText("not this list's row 1")).toBeNull();
    expect(screen.queryByText("not this list")).toBeNull();
  });

  it("has no Move buttons when not reorderable, and no actions when disabled", () => {
    render(<Harness initial={[A, B]} reorderable={false} />);
    expect(screen.queryByRole("button", { name: /^Move link/ })).toBeNull();
    cleanup();
    render(<Harness initial={[A]} disabled />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Link text")).toBeDisabled();
  });

  it("withoutBlankLinks drops only completely blank rows", () => {
    expect(withoutBlankLinks([{ text: " ", url: "", summary: "" }, { text: "", url: "/x" }, A])).toEqual([{ text: "", url: "/x" }, A]);
  });
});
