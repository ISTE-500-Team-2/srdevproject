// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StaffUsers } from "./StaffUsers";
import { staffPerson } from "../testing/fixtures";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../lib/useApi", () => ({ useApi }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ openAccount: vi.fn() }) }));
vi.mock("../components/staff/record/MemberRecord", () => ({ MemberRecord: () => null }));
afterEach(() => {
  cleanup();
  useApi.mockReset();
});

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
