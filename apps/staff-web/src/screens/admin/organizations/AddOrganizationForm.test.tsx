import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { AddOrganizationForm } from "./AddOrganizationForm";

function stub(
  respond: () => Response,
  calls: { url: string; init?: RequestInit }[],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }),
  );
}

describe("AddOrganizationForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("previews the key as you type", async () => {
    render(<AddOrganizationForm onCreated={() => {}} onCancel={() => {}} />);
    await userEvent
      .setup()
      .type(screen.getByLabelText(/Ministry name/), "Citizens' Services");
    expect(
      screen.getByText("Web address: /site/ministries/citizens-services/"),
    ).toBeInTheDocument();
  });

  it("posts the new ministry and reports its key", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(() => jsonResponse(201, { key: "citizens-services" }), calls);
    const onCreated = vi.fn();
    render(<AddOrganizationForm onCreated={onCreated} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Ministry name/),
      "Citizens' Services",
    );
    await user.click(screen.getByRole("button", { name: "Create ministry" }));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith("citizens-services"),
    );
    expect(calls[0]!.url).toBe("/core/api/organizations");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      displayName: "Citizens' Services",
    });
  });

  it("409 says the ministry already exists", async () => {
    stub(
      () => jsonResponse(409, { error: "exists", key: "citizens-services" }),
      [],
    );
    const onCreated = vi.fn();
    render(<AddOrganizationForm onCreated={onCreated} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Ministry name/),
      "Citizens' Services",
    );
    await user.click(screen.getByRole("button", { name: "Create ministry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A ministry with this name already exists (citizens-services).",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("409 for an inactive ministry points to Reactivate", async () => {
    stub(
      () => jsonResponse(409, { error: "exists", key: "citizens-services" }),
      [],
    );
    const orgs = [
      {
        key: "citizens-services",
        displayName: "Citizens' Services",
        isActive: false,
      },
    ] as OrgRecord[];
    render(
      <AddOrganizationForm
        orgs={orgs}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Ministry name/),
      "Citizens Services",
    );
    await user.click(screen.getByRole("button", { name: "Create ministry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Citizens' Services already exists but is inactive. Use Reactivate on its row.",
    );
  });

  it("409 for an active ministry keeps the generic message", async () => {
    stub(
      () => jsonResponse(409, { error: "exists", key: "citizens-services" }),
      [],
    );
    const orgs = [
      {
        key: "citizens-services",
        displayName: "Citizens' Services",
        isActive: true,
      },
    ] as OrgRecord[];
    render(
      <AddOrganizationForm
        orgs={orgs}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Ministry name/),
      "Citizens Services",
    );
    await user.click(screen.getByRole("button", { name: "Create ministry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A ministry with this name already exists (citizens-services).",
    );
  });

  it("will not submit a name that has no letters or digits", async () => {
    render(<AddOrganizationForm onCreated={() => {}} onCancel={() => {}} />);
    await userEvent.setup().type(screen.getByLabelText(/Ministry name/), "!!!");
    expect(
      screen.getByRole("button", { name: "Create ministry" }),
    ).toBeDisabled();
  });
});
