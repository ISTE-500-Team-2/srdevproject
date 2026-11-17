// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { StaffUsers } from "./StaffUsers";
import { staffPerson } from "../testing/fixtures";
import type { MemberRecord } from "../components/staff/record/MemberRecord";

const { useApi, record } = vi.hoisted(() => ({ useApi: vi.fn(), record: vi.fn() }));
vi.mock("../lib/useApi", () => ({ useApi }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ openAccount: vi.fn() }) }));
vi.mock("../components/staff/record/MemberRecord", () => ({
  MemberRecord: (props: unknown) => {
    record(props);
    return null;
  },
}));
afterEach(() => {
  cleanup();
  useApi.mockReset();
  record.mockReset();
});

const lastRecord = () => record.mock.lastCall?.[0] as ComponentProps<typeof MemberRecord>;
const read = (data: unknown, over: { loading?: boolean; error?: string; reload?: () => void } = {}) => ({
  data,
  loading: false,
  refreshing: false,
  stale: false,
  error: "",
  reload: vi.fn(),
  ...over,
});
function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}
const at = (url: string) => (
  <MemoryRouter initialEntries={[url]}>
    <StaffUsers />
    <Search />
  </MemoryRouter>
);

test("another search or page keeps the members on screen, out of reach, while the search box and pager stay usable", () => {
  const people = { items: [staffPerson({ id: 4, firstName: "Casey", lastName: "Demo" })], nextOffset: 50 };
  useApi.mockImplementation((path: string | null) => ({
    data: path?.startsWith("/admin/users?") ? people : null,
    loading: false,
    refreshing: false,
    stale: !!path?.startsWith("/admin/users?"),
    error: "",
    reload: vi.fn(),
  }));
  render(
    <MemoryRouter>
      <StaffUsers />
    </MemoryRouter>,
  );
  expect(useApi.mock.calls.find(([path]) => path?.startsWith("/admin/users?"))?.[1]).toMatchObject({ retainOnChange: true });
  const results = document.querySelector(".kept-results")!;
  expect(results.contains(screen.getByRole("button", { name: "Casey Demo" }))).toBe(true);
  expect(results.hasAttribute("inert")).toBe(true);
  // Typing never loses focus, and the pager waits rather than paging on from old offsets.
  expect(results.contains(screen.getByLabelText("Search members by name or email"))).toBe(false);
  const next = screen.getByRole("button", { name: "Next page" });
  expect(results.contains(next)).toBe(false);
  expect(next.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(next);
  expect(useApi.mock.calls.some(([path]) => path?.includes("offset=50"))).toBe(false);
});

test("the return-from-checkout notice stays with the member it came back for", () => {
  const casey = staffPerson({ id: 5, firstName: "Casey", lastName: "Demo" });
  const jordan = staffPerson({ id: 9, firstName: "Jordan", lastName: "Lee" });
  useApi.mockImplementation((path: string | null) =>
    path?.startsWith("/admin/users?") ? read({ items: [casey, jordan], nextOffset: null }) : read(path === "/admin/users/5" ? { user: casey } : null),
  );
  render(at("/admin/members?billing=returned&member=5"));
  expect(lastRecord().id).toBe(5);
  expect((lastRecord().notice as ReactElement<{ children: string }>).props.children).toMatch(/^Returned from Stripe/);
  act(() => lastRecord().onClose());
  expect(screen.getByTestId("search").textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Jordan Lee" }));
  expect(lastRecord().id).toBe(9);
  expect(lastRecord().notice).toBeUndefined();
});

test("a link to a member record says it's opening, and why it didn't, with a retry", () => {
  const reload = vi.fn();
  let linked = read(null, { loading: true });
  useApi.mockImplementation((path: string | null) =>
    path?.startsWith("/admin/users?") ? read({ items: [], nextOffset: null }) : path === "/admin/users/77" ? linked : read(null),
  );
  const { rerender } = render(at("/admin/members?member=77"));
  expect(screen.getByRole("status").textContent).toBe("Opening member #77’s record…");
  linked = read(null, { error: "The selected record was not found.", reload });
  rerender(at("/admin/members?member=77"));
  expect(screen.getByRole("alert").textContent).toMatch(/^Member #77’s record didn’t open\. The selected record was not found\./);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
});
