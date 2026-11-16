// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { User } from "../lib/contracts";
import { certification, overview, reservation, user as account } from "../testing/fixtures";

const auth = vi.hoisted(() => ({ user: null as User | null, actor: null as User | null }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), api }));
import { AccountHomePage } from "./AccountHomePage";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const staff = account({ id: 2, firstName: "Sam", role: "staff", roles: ["staff"] });
const dana = account({ id: 7, firstName: "Dana", email: "dana@example.invalid" });
const eli = account({ id: 8, firstName: "Eli", email: "eli@example.invalid" });
const soon = new Date(Date.now() + 86_400_000);

// The server answers /me/* and /reservations for whichever account is open.
const records: Record<number, { certifications: unknown[]; bookings: unknown[] }> = {
  [dana.id]: {
    certifications: [certification({ id: 3, name: "Laser Training" })],
    bookings: [reservation({ id: 5, userId: dana.id, equipmentName: "Dana's lathe", startTime: soon.toISOString(), endTime: new Date(soon.getTime() + 3_600_000).toISOString() })],
  },
  [eli.id]: { certifications: [], bookings: [] },
};
function serve() {
  api.mockImplementation(async (path: string) => {
    const open = auth.user!.id;
    if (path.startsWith("/me/overview")) return overview({ userId: open });
    if (path === "/me/certifications") return records[open]!.certifications;
    if (path === "/reservations") return records[open]!.bookings;
    if (path.startsWith("/admin/users/")) return { memberships: [], passes: [] };
    throw new Error("Unexpected request " + path);
  });
}

test("switching to another member's account shows that member's certifications and bookings", async () => {
  serve();
  auth.actor = staff;
  auth.user = dana;
  const page = () => <MemoryRouter><AccountHomePage /></MemoryRouter>;
  const { rerender } = render(page());
  const snapshot = () => screen.getByRole("complementary");
  expect(await within(snapshot()).findByText("Dana's lathe")).toBeTruthy();
  expect(within(snapshot()).getByText("Laser Training")).toBeTruthy();

  // The account picker opens Eli on the same route, so the page stays mounted.
  auth.user = eli;
  rerender(page());
  expect(await within(snapshot()).findByText("None yet")).toBeTruthy();
  expect(await within(snapshot()).findByText("None")).toBeTruthy();
  expect(within(snapshot()).queryByText("Dana's lathe")).toBeNull();
  expect(within(snapshot()).queryByText("Laser Training")).toBeNull();
});
