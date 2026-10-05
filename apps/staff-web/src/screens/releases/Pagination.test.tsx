import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "./Pagination";

describe("Pagination", () => {
  afterEach(() => cleanup());

  it('shows "Showing 26–50 of 112" for page 2 of 25-per-page results', () => {
    render(<Pagination page={2} pageSize={25} total={112} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 26–50 of 112")).toBeInTheDocument();
  });

  it("clamps the end of the last, partial page to the total", () => {
    render(<Pagination page={5} pageSize={25} total={112} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 101–112 of 112")).toBeInTheDocument();
  });

  it("clamps defensively when page is past the last page (fix round 1, finding 3)", () => {
    // page=5 with pageSize=25 and total=30 has only 2 pages — an unclamped (page-1)*pageSize+1
    // would show "Showing 101–30 of 30". The screens themselves correct the URL in this case
    // (see ReleaseListScreen/SearchScreen), but Pagination must never render nonsense either.
    render(<Pagination page={5} pageSize={25} total={30} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 26–30 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("disables Previous on page 1 and Next on the last page", () => {
    render(<Pagination page={1} pageSize={25} total={30} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    cleanup();
    render(<Pagination page={2} pageSize={25} total={30} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("calls onPageChange with page ± 1", async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageSize={25} total={112} onPageChange={onPageChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("renders nothing when there are no results", () => {
    const { container } = render(<Pagination page={1} pageSize={25} total={0} onPageChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
