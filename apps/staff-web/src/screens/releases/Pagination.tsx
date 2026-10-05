import { Button, ButtonGroup } from "@bcgov/design-system-react-components";

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
}

/** "Showing 26–50 of 112" + Previous/Next, shared by every release list tab and the search
 * screen. `page`/`pageSize`/`total` come straight off the server's `ReleasePage` response, so
 * the math here always matches what was actually returned. */
export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps): React.JSX.Element | null {
  if (total === 0) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="gcpe-pagination">
      <p>
        Showing {start}–{end} of {total}
      </p>
      <ButtonGroup ariaLabel="Pagination controls">
        <Button isDisabled={page <= 1} onPress={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button isDisabled={end >= total} onPress={() => onPageChange(page + 1)}>
          Next
        </Button>
      </ButtonGroup>
    </nav>
  );
}
