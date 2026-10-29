import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { ReferenceBlock } from "./ReferenceBlock";

describe("ReferenceBlock", () => {
  afterEach(cleanup);

  it("shows key and reference when set; the activity id only in Publish settings", () => {
    render(<ReferenceBlock view={releaseView({ key: "clinics-open", reference: "NEWS-12345", activityId: 987 })} />);
    expect(screen.getByText("clinics-open")).toBeInTheDocument();
    expect(screen.getByText("NEWS-12345")).toBeInTheDocument();
    expect(screen.queryByText("987")).toBeNull();
    expect(screen.queryByText("Calendar activity ID")).toBeNull();
  });

  it("shows placeholders for anything not set yet", () => {
    render(<ReferenceBlock view={releaseView({ key: null, reference: null, activityId: null })} />);
    expect(screen.getAllByText("(none yet)")).toHaveLength(2);
  });
});
