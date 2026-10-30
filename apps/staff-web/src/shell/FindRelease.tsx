import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Form, TextField } from "@bcgov/design-system-react-components";
import { ApiError } from "../api/client";
import { Button } from "../shared/BusyButton";
import { useSearchShortcut } from "../shared/shortcuts";
import { gotoReleaseId } from "../screens/search/findRelease";

export const FIND_RELEASE_INPUT_ID = "find-release-q";

/**
 * "Find a release", at the top of the side menu on every screen: a reference number (NEWS-00007),
 * key or id opens that release straight away; anything else opens the Search results for the
 * words — exactly what Search's own box does, without going to Search first. ⌘/Ctrl+K comes here
 * on any screen that has no search or filter box of its own (`reveal` opens the folded phone menu
 * first).
 */
export function FindRelease({ reveal }: { reveal: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only where the screen has no search or filter box of its own: that box always wins the key.
  useSearchShortcut(FIND_RELEASE_INPUT_ID, reveal, { fallback: true });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const typed = text.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await gotoReleaseId(typed);
      setText("");
      navigate(id ? `/releases/${id}` : `/search?${new URLSearchParams({ q: typed })}`);
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't search. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={onSubmit} role="search" aria-label="Find a release" className="gcpe-find-release">
      <TextField
        id={FIND_RELEASE_INPUT_ID}
        label="Find a release"
        description="A number (NEWS-00007) or words"
        name="q"
        value={text}
        onChange={setText}
        className="bcds-react-aria-TextField gcpe-find-release__q"
      />
      <Button type="submit" size="small" variant="secondary" isPending={busy} pendingLabel="Finding…">
        Find
      </Button>
      {error && (
        <p role="alert" className="gcpe-find-release__error">
          {error}
        </p>
      )}
    </Form>
  );
}
