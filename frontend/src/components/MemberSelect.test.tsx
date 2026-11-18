// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberSelect } from "./MemberSelect";
import { Modal } from "./Modal";
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

test("Enter never picks from an earlier, shorter search's matches", async () => {
  // Longer searches answer only when released, so even a slow run can't let "jordan" land before
  // the first Enter: that Enter sees the "jo" matches, or a search still loading.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const searchOf = (path: string) => new URLSearchParams(path.split("?")[1]).get("search");
  vi.mocked(api).mockImplementation(async (path) =>
    (searchOf(path) === "jo"
      ? { items: [{ id: 21, name: "Joan Adams", email: "joan@example.invalid" }], hasMore: false }
      : held.then(() => ({ items: [{ id: 22, name: "Jordan Lee", email: "jordan@example.invalid" }], hasMore: false }))) as never,
  );
  const user = userEvent.setup();
  render(
    <form aria-label="Select member">
      <MemberSelect name="userId" />
    </form>,
  );
  const box = screen.getByRole("combobox", { name: "Member" });
  await user.type(box, "jo");
  await screen.findByRole("option", { name: /Joan Adams/ });
  // Typed on and pressed Enter before the new search ran: "jo" matches are still listed.
  await user.type(box, "rdan{Enter}");
  expect(formValue("userId")).toBe("");
  await vi.waitFor(() => expect(vi.mocked(api).mock.calls.some(([path]) => searchOf(path) === "jordan")).toBe(true));
  release();
  await screen.findByRole("option", { name: /Jordan Lee/ });
  await user.keyboard("{Enter}");
  expect(formValue("userId")).toBe("22");
});

test("Escape closes the matches, not the dialog the field is in", async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: 12, name: "Jordan Example", email: "jordan@example.invalid" }], hasMore: false });
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <Modal open title="Schedule a class" onClose={close}>
      <MemberSelect name="instructorId" label="Instructor" />
    </Modal>,
  );
  await user.type(screen.getByRole("combobox", { name: "Instructor" }), "Jordan");
  await screen.findByRole("option", { name: /Jordan Example/ });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  // With the matches closed, Escape closes the dialog as usual.
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
});

test("after a pick, focus moves to the choice and the choice is announced", async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: 12, name: "Jordan Example", email: "jordan@example.invalid" }], hasMore: false });
  const user = userEvent.setup();
  render(
    <Modal open title="Book equipment" onClose={() => {}}>
      <MemberSelect name="userId" />
      <button type="button">Book</button>
    </Modal>,
  );
  await user.type(screen.getByRole("combobox", { name: "Member" }), "Jordan");
  await screen.findByRole("option", { name: /Jordan Example/ });
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("group", { name: "Member" }));
  expect(screen.getByText("Selected Jordan Example").getAttribute("aria-live")).toBe("polite");
  // A second or held Enter lands on the choice, not on Change, so it keeps the pick.
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("combobox")).toBeNull();
  // The next Tabs carry on through the form instead of jumping back to Close.
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change member" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Book" }));
  // Changing the person clears the announcement, so picking the same person again is announced.
  await user.click(screen.getByRole("button", { name: "Change member" }));
  expect(screen.queryByText("Selected Jordan Example")).toBeNull();
});
