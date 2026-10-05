import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useDocumentTitle } from "./useDocumentTitle";

function Screen({ text }: { text: string }) {
  useDocumentTitle(text);
  return <h1>{text}</h1>;
}

describe("useDocumentTitle (I5)", () => {
  afterEach(cleanup);

  it("sets document.title to \"<text> — GCPE News Staff\"", () => {
    render(<Screen text="Carousel" />);
    expect(document.title).toBe("Carousel — GCPE News Staff");
  });

  it("updates the title when the text changes (e.g. a release's headline loads in)", () => {
    const { rerender } = render(<Screen text="Loading…" />);
    expect(document.title).toBe("Loading… — GCPE News Staff");
    rerender(<Screen text="Clinics open longer hours" />);
    expect(document.title).toBe("Clinics open longer hours — GCPE News Staff");
  });

  it("null/undefined leaves whatever title is already set untouched", () => {
    function Parent({ child }: { child: string | null }) {
      useDocumentTitle(child);
      return <p>parent</p>;
    }
    document.title = "Clinics open longer hours — GCPE News Staff";
    render(<Parent child={null} />);
    expect(document.title).toBe("Clinics open longer hours — GCPE News Staff");
  });
});
