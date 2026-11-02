import { useId, useState } from "react";
import { Dialog, Modal, ToggleButton } from "@bcgov/design-system-react-components";
import { Button } from "../../../shared/BusyButton";

/** `POST /core/api/organizations/:key/profile/preview` (C324): the ministry page and, when the
 * minister has a biography, the biography page, as a save of the form would leave them. */
export interface MinistryPreviewPages {
  ministryPage: string;
  biographyPage: string | null;
  /** False when the public site doesn't show the ministry (inactive, or not public). */
  onSite: boolean;
}

export const PREVIEW_NOTE = "Not saved. This is how the public pages will look once you save. Links open the live site in a new tab.";
export const PREVIEW_OFF_SITE = "The public site doesn't show this ministry now: it is inactive or not public.";

/**
 * The preview, filling the window over the form: the rendered page in a frame, with Ministry page /
 * Biography page to switch between them and Close preview (or Esc) to return to the form, unchanged.
 * The frame shows the public site's own HTML and stylesheets, so it looks as the page will.
 */
export function MinistryPreview({ name, pages, onClose }: { name: string; pages: MinistryPreviewPages; onClose: () => void }): React.JSX.Element {
  const headingId = useId();
  const [shown, setShown] = useState<"ministry" | "biography">("ministry");
  const html = shown === "biography" && pages.biographyPage !== null ? pages.biographyPage : pages.ministryPage;
  const pageName = shown === "biography" && pages.biographyPage !== null ? "biography page" : "ministry page";
  return (
    <Modal isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
      <Dialog aria-labelledby={headingId} className="gcpe-preview">
        <div className="gcpe-preview__bar">
          <div>
            <h2 id={headingId}>Preview: {name}</h2>
            <p>{PREVIEW_NOTE}</p>
            {!pages.onSite && <p role="note">{PREVIEW_OFF_SITE}</p>}
          </div>
          <div className="gcpe-preview__actions">
            {pages.biographyPage !== null && (
              <div className="gcpe-preview__pages">
                <ToggleButton size="small" isSelected={shown === "ministry"} onChange={() => setShown("ministry")}>
                  Ministry page
                </ToggleButton>
                <ToggleButton size="small" isSelected={shown === "biography"} onChange={() => setShown("biography")}>
                  Biography page
                </ToggleButton>
              </div>
            )}
            <Button variant="secondary" onPress={onClose}>
              Close preview
            </Button>
          </div>
        </div>
        {/* No navigation away from the Hub: links open in a new tab (the page's <base target>). */}
        <iframe
          key={shown}
          className="gcpe-preview__frame"
          title={`Preview of the ${pageName} for ${name}`}
          srcDoc={html}
          sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"
        />
      </Dialog>
    </Modal>
  );
}
