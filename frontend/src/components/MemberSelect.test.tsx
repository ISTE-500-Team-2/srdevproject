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
const formValue = (key: string) => new FormData(screen.getByRole("form") as HTMLFormElement).get(key);

test("type a name, pick a match, and the form submits that person's id", async () => {
  vi.mocked(api).mockResolvedValueOnce({
    items: [
      { id: 12, name: "Jordan Example", email: "jordan@example.invalid" },
      { id: 13, name: "Jordan Other", email: "other@example.invalid" },
    ],
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
  const box = screen.getByRole("combobox", { name: "Member" });
  await user.type(box, "Jordan");
  await screen.findByRole("option", { name: /Jordan Example/ });
  // Enter on a half-typed search picks the highlighted match, never submits.
  await user.keyboard("{ArrowDown}{Enter}");
  expect(submit).not.toHaveBeenCalled();
  expect(formValue("userId")).toBe("13");
  expect(screen.getByText("Jordan Other")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Change member" }));
  expect(formValue("userId")).toBe("");
  expect(screen.getByRole("combobox", { name: "Member" })).toBeTruthy();
});

test("typed text that wasn't picked can't pass as a choice", async () => {
  vi.mocked(api).mockResolvedValue({ items: [], hasMore: false });
  const user = userEvent.setup();
  render(
    <form aria-label="Select member">
      <MemberSelect name="userId" />
    </form>,
  );
  const box = screen.getByRole("combobox", { name: "Member" }) as HTMLInputElement;
  expect(box.validity.valueMissing).toBe(true);
  await user.type(box, "Nobody");
  expect(box.validationMessage).toBe("Choose member from the list.");
  expect(await screen.findByText("No matching people.")).toBeTruthy();
});

test("instructor-only searches keep their scope; errors and capped results are visible", async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("Lookup denied"))
    .mockResolvedValueOnce({ items: [], hasMore: true });
  const user = userEvent.setup();
  render(<MemberSelect name="instructorId" label="Assigned instructor" instructorsOnly />);
  await user.type(screen.getByRole("combobox", { name: "Assigned instructor" }), "Alex");
  expect((await screen.findByRole("alert")).textContent).toContain("Lookup denied");
  expect(vi.mocked(api).mock.calls[0][0]).toContain("role=instructor");
  await user.click(screen.getByRole("button", { name: "Retry search" }));
  expect(await screen.findByText("More matches exist. Refine your search.")).toBeTruthy();
});
