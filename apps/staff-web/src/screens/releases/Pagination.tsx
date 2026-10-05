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

  // Defensive clamp (fix round 1, finding 3): a `page` past the last page — e.g. the result
  // set shrank after it was fetched — would otherwise show a nonsensical range like "Showing
  // 101–30 of 30". The screens themselves correct the URL back to the last valid page when
  // this happens (see ReleaseListScreen/SearchScreen); this is just a second line of defence.
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(page, 1), lastPage);

  const start = (clampedPage - 1) * pageSize + 1;
  const end = Math.min(clampedPage * pageSize, total);

  return (
    <nav aria-label="Pagination" className="gcpe-pagination">
      <p>
        Showing {start}–{end} of {total}
      </p>
      <ButtonGroup ariaLabel="Pagination controls">
        <Button isDisabled={clampedPage <= 1} onPress={() => onPageChange(clampedPage - 1)}>
          Previous
        </Button>
        <Button isDisabled={clampedPage >= lastPage} onPress={() => onPageChange(clampedPage + 1)}>
          Next
        </Button>
      </ButtonGroup>
    </nav>
  );
}
