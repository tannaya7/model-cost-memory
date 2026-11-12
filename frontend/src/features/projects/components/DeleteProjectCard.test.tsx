import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { getActiveProject, setActiveProject } from "../../../shared/api/apiFetch";
import { DeleteProjectCard } from "./DeleteProjectCard";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown = null) {
  const fetch = vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("DeleteProjectCard", () => {
  it("deletes only after the project id is typed exactly", async () => {
    const fetch = stubFetch(204);
    const onDeleted = vi.fn();
    setActiveProject("acme-1234");
    renderWithProviders(<DeleteProjectCard projectId="acme-1234" projectName="Acme" onDeleted={onDeleted} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Delete this project/ }));
    const confirm = screen.getByRole("button", { name: "Delete project and all its data" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/to confirm/), "acme-123");
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/to confirm/), "4");
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/projects/acme-1234?confirm=acme-1234");
    expect(init.method).toBe("DELETE");
    expect(getActiveProject()).toBe(""); // the deleted project is no longer the active one
  });

  it("shows the server's reason and stays on the page when deleting fails", async () => {
    stubFetch(404, { detail: "Project not found" });
    const onDeleted = vi.fn();
    renderWithProviders(<DeleteProjectCard projectId="acme-1234" projectName="Acme" onDeleted={onDeleted} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Delete this project/ }));
    await user.type(screen.getByLabelText(/to confirm/), "acme-1234");
    await user.click(screen.getByRole("button", { name: "Delete project and all its data" }));
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("cancel closes the confirmation and forgets what was typed", async () => {
    renderWithProviders(<DeleteProjectCard projectId="acme-1234" projectName="Acme" onDeleted={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Delete this project/ }));
    await user.type(screen.getByLabelText(/to confirm/), "acme-1234");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: /Delete this project/ }));
    expect(screen.getByLabelText(/to confirm/)).toHaveValue("");
  });
});
