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

  describe("abbreviation", () => {
    it("is an optional field with its hint; blank is not sent", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      stub(() => jsonResponse(201, { key: "mining" }), calls);
      render(<AddOrganizationForm onCreated={() => {}} onCancel={() => {}} />);
      expect(screen.getByLabelText("Abbreviation")).toHaveAccessibleDescription(
        "Used in release numbers, e.g. 2026HLTH0001. Changing it affects only releases approved from now on.",
      );
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/Ministry name/), "Mining");
      await user.click(screen.getByRole("button", { name: "Create ministry" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        displayName: "Mining",
      });
    });

    it("sends it trimmed and upper-cased", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      stub(() => jsonResponse(201, { key: "mining" }), calls);
      render(<AddOrganizationForm onCreated={() => {}} onCancel={() => {}} />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/Ministry name/), "Mining");
      await user.type(screen.getByLabelText("Abbreviation"), " mcm ");
      await user.click(screen.getByRole("button", { name: "Create ministry" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        displayName: "Mining",
        abbreviation: "MCM",
      });
    });

    it("a 409 abbreviation-taken names the ministry that uses it, on the field", async () => {
      stub(
        () =>
          jsonResponse(409, { error: "abbreviation-taken", takenBy: "Health" }),
        [],
      );
      const onCreated = vi.fn();
      render(<AddOrganizationForm onCreated={onCreated} onCancel={() => {}} />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/Ministry name/), "Mining");
      await user.type(screen.getByLabelText("Abbreviation"), "HLTH");
      await user.click(screen.getByRole("button", { name: "Create ministry" }));
      const field = screen.getByLabelText("Abbreviation");
      await waitFor(() =>
        expect(field).toHaveAccessibleDescription(
          expect.stringContaining(
            "That abbreviation is already used by Health.",
          ),
        ),
      );
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(onCreated).not.toHaveBeenCalled();
    });
  });

  it("will not submit a name that has no letters or digits", async () => {
    render(<AddOrganizationForm onCreated={() => {}} onCancel={() => {}} />);
    await userEvent.setup().type(screen.getByLabelText(/Ministry name/), "!!!");
    expect(
      screen.getByRole("button", { name: "Create ministry" }),
    ).toBeDisabled();
  });
});
