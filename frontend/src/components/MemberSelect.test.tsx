// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberSelect } from "./MemberSelect";
import { api } from "../lib/api";
vi.mock("../lib/api", () => ({
  api: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("searches names, submits selected identity and retains selection when results change", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({
      items: [
        { id: 12, name: "Jordan Example", email: "jordan@example.invalid" },
      ],
      hasMore: false,
    })
    .mockResolvedValueOnce({
      items: [{ id: 99, name: "Other Person", email: "other@example.invalid" }],
      hasMore: false,
    });
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  render(
    <form aria-label="Select member" onSubmit={submit}>
      <MemberSelect name="userId" />
    </form>,
  );
  expect(api).not.toHaveBeenCalled();
  await user.type(
    screen.getByLabelText("Find member by name or email"),
    "Jordan",
  );
  await screen.findByRole("option", { name: /Jordan Example/ });
  await user.selectOptions(screen.getByLabelText("Member"), "12");
  expect(
    new FormData(screen.getByRole("form") as HTMLFormElement).get("userId"),
  ).toBe("12");
  await user.clear(screen.getByLabelText("Find member by name or email"));
  await user.type(
    screen.getByLabelText("Find member by name or email"),
    "Other",
  );
  await screen.findByRole("option", { name: /Other Person/ });
  expect((screen.getByLabelText("Member") as HTMLSelectElement).value).toBe(
    "12",
  );
  expect(screen.getByRole("option", { name: /Jordan Example/ })).toBeTruthy();
  await user.click(screen.getByLabelText("Find member by name or email"));
  await user.keyboard("{Enter}");
  expect(submit).not.toHaveBeenCalled();
});
test("instructor-only searches preserve permission scope; errors and capped results are visible", async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("Lookup denied"))
    .mockResolvedValueOnce({ items: [], hasMore: true });
  const user = userEvent.setup();
  render(
    <MemberSelect
      name="instructorId"
      label="Assigned instructor"
      instructorsOnly
    />,
  );
  await user.type(
    screen.getByLabelText("Find assigned instructor by name or email"),
    "Alex",
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Lookup denied",
  );
  expect(vi.mocked(api).mock.calls[0][0]).toContain("role=instructor");
  await user.click(screen.getByRole("button", { name: "Retry search" }));
  expect(
    await screen.findByText("More matches exist. Refine your search."),
  ).toBeTruthy();
});
