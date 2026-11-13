// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AccessManagementPage } from "./AccessManagementPage";
import { api, ApiError } from "../lib/api";
import type { AccessReadinessResult } from "../lib/accessReadiness";
import type { CardAssignment, CardScan, NfcCard, ReaderSetup } from "../lib/nfc";
import type { Person } from "../lib/staffContracts";
import type { Tap } from "../components/access/TapHistory";
import { mockApi } from "../testing/apiMock";
import { staffPerson } from "../testing/fixtures";
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: vi.fn(),
}));
const jordan = staffPerson({
    id: 12,
    firstName: "Jordan",
    lastName: "Example",
    email: "jordan@example.invalid",
  }),
  alex = staffPerson({
    id: 13,
    firstName: "Alex",
    lastName: "Example",
    email: "alex@example.invalid",
  });
// MemberSelect's search response (GET /training/members).
type MemberSearch = {
  items: { id: number; name: string; email: string }[];
  hasMore: boolean;
};
const setup = {
  configured: true,
  timeZone: "America/New_York",
  readers: [
    {
      id: "front",
      name: "Front door",
      kind: "building",
      resourceId: 1,
      resourceName: "Main building",
      enabled: true,
      online: true,
      revision: 1,
      lastSeenAt: new Date().toISOString(),
    },
  ],
} satisfies ReaderSetup;
const card: NfcCard = {
  id: 1,
  label: "Blue card",
  active: true,
  revision: 1,
  last4: "1234",
  assignedAt: "2026-01-01T12:00:00Z",
  assignedBy: "Staff Example",
  lastUsedAt: null,
  lastReader: null,
};
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const taps: Tap[] = [
  { id: 90, readerId: "front", readerName: "Front door", userId: 12, memberName: "Jordan Example", last4: "1234", allowed: false, reason: "WAIVER_REQUIRED", createdAt: minutesAgo(2) },
  { id: 89, readerId: "front", readerName: "Front door", userId: null, memberName: null, last4: "4F21", allowed: false, reason: "CARD_NOT_ASSIGNED", createdAt: minutesAgo(14) },
  { id: 88, readerId: "front", readerName: "Front door", userId: 13, memberName: "Alex Example", last4: "5678", allowed: true, reason: "ELIGIBLE", createdAt: minutesAgo(30) },
  ...[87, 86, 85].map((id) => ({ id, readerId: "front", readerName: "Front door", userId: 13, memberName: "Alex Example", last4: "5678", allowed: true, reason: "ELIGIBLE", createdAt: minutesAgo(200) })),
];
let cards: Record<number, NfcCard[]>,
  configured: boolean,
  mutation: (path: string, body: unknown) => Promise<unknown>;
beforeEach(() => {
  cards = { 12: [], 13: [] };
  configured = true;
  mutation = async () => ({});
  mockApi(async (path, options) => {
    if (options?.method) return mutation(path, options.body);
    if (path.startsWith("/admin/access/events?")) {
      const denied = path.includes("result=denied");
      return {
        items: taps.filter((t) => !denied || !t.allowed),
        nextBefore: null,
      } satisfies { items: Tap[]; nextBefore: number | null };
    }
    if (path === "/admin/access/readers")
      return { ...setup, configured } satisfies ReaderSetup;
    if (path.startsWith("/admin/users/") && !path.includes("access-readiness"))
      return { user: path.endsWith("/12") ? jordan : alex } satisfies {
        user: Person;
      };
    if (path.startsWith("/admin/access/cards?"))
      return cards[
        Number(new URLSearchParams(path.split("?")[1]).get("userId"))
      ];
    if (path.includes("access-readiness"))
      return {
        userId: Number(path.split("/")[3]),
        readerId: "front",
        readers: [],
        allowed: false,
        reason: "CARD_NOT_ASSIGNED",
        cardAssigned: false,
        checkedAt: new Date().toISOString(),
        expiresAt: null,
      } satisfies AccessReadinessResult;
    if (path.startsWith("/training/members?"))
      return {
        items: [jordan, alex].map((p) => ({
          id: p.id,
          name: `${p.firstName} ${p.lastName}`,
          email: p.email,
        })),
        hasMore: false,
      } satisfies MemberSearch;
    if (path.startsWith("/admin/access/enrollments/"))
      return {
        id: "scan-one",
        readerId: "front",
        userId: 12,
        purpose: "assign",
        status: "captured",
        last4: "7788",
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        assignments: [],
      } satisfies CardScan;
    throw new Error("Unexpected path " + path);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function mount(path = "/admin/access?member=12") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AccessManagementPage />
    </MemoryRouter>,
  );
}
async function manual() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Enter a card ID manually" }),
  );
}
async function fillAssignment() {
  await userEvent.type(screen.getByLabelText("NFC card ID"), "04112233");
  await userEvent.type(screen.getByLabelText("Card label"), "New card");
  await userEvent.type(
    screen.getByLabelText("Assignment reason"),
    "Verified identity",
  );
}

test("member link displays the selected person and automatically loads cards", async () => {
  mount();
  expect(
    await screen.findByRole("heading", {
      name: "NFC cards for Jordan Example",
    }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("group", { name: "Member" })).getByText(
      "Jordan Example",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load cards" })).toBeNull();
  expect(await screen.findByText(/No NFC cards are assigned/)).toBeTruthy();
  expect(api).toHaveBeenCalledWith(
    "/admin/access/cards?userId=12",
    expect.anything(),
  );
});
test("changing members removes old controls and typed values; the next assignment targets the selected person", async () => {
  mount();
  await manual();
  await fillAssignment();
  await userEvent.click(screen.getByRole("button", { name: "Change member" }));
  expect(screen.queryByRole("button", { name: "Assign card" })).toBeNull();
  await userEvent.type(
    screen.getByRole("combobox", { name: "Member" }),
    "Alex",
  );
  fireEvent.mouseDown(
    await screen.findByRole("option", { name: /Alex Example/ }),
  );
  await screen.findByRole("heading", { name: "NFC cards for Alex Example" });
  await manual();
  expect((screen.getByLabelText("NFC card ID") as HTMLInputElement).value).toBe(
    "",
  );
  await fillAssignment();
  await userEvent.click(screen.getByRole("button", { name: "Assign card" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/access/cards", {
      method: "POST",
      body: {
        userId: 13,
        uid: "04112233",
        label: "New card",
        reason: "Verified identity",
      },
    }),
  );
  expect(
    await screen.findByText(/NFC card assigned to Alex Example/),
  ).toBeTruthy();
});
test("manual ID help explains accepted lengths and bad input never reaches the server", async () => {
  mount();
  await manual();
  await userEvent.type(screen.getByLabelText("NFC card ID"), "123");
  await userEvent.type(screen.getByLabelText("Card label"), "New card");
  await userEvent.type(screen.getByLabelText("Assignment reason"), "Reason");
  await userEvent.click(screen.getByRole("button", { name: "Assign card" }));
  expect(screen.getByRole("alert").textContent).toContain("8, 14 or 20");
  expect(screen.getByText(/Find the card ID in your NFC reader/)).toBeTruthy();
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([p, o]) => p === "/admin/access/cards" && o?.method === "POST",
      ),
  ).toBe(false);
});
test("setup failure is explained before the assignment form is offered", async () => {
  configured = false;
  mount();
  expect(await screen.findByText(/NFC setup is incomplete/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start card scan" })).toBeNull();
  expect(screen.queryByLabelText("Card label")).toBeNull();
});
test("revocation requires confirmation, stale errors reload cards and the retry uses the latest revision", async () => {
  cards[12] = [{ ...card }];
  let attempts = 0;
  mutation = async (path, body) => {
    if (path.endsWith("/revoke")) {
      attempts++;
      if (attempts === 1) {
        cards[12] = [{ ...card, revision: 2 }];
        throw new ApiError(
          409,
          "STALE_RECORD",
          "This card changed. Review the latest cards.",
        );
      }
      expect(body).toHaveProperty("expectedRevision", 2);
      cards[12] = [{ ...card, revision: 3, active: false }];
    }
    return {};
  };
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke Blue card" }),
  );
  expect(attempts).toBe(0);
  let dialog = screen.getByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Reason"), "Lost card");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm revocation" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("This card changed"),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Revoke Blue card" }),
  );
  dialog = screen.getByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Reason"), "Lost card");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm revocation" }),
  );
  expect(
    await screen.findByRole("button", { name: "Reactivate Blue card" }),
  ).toBeTruthy();
  expect(attempts).toBe(2);
});
test("refresh cards refetches the same member and displays assignment metadata", async () => {
  cards[12] = [{ ...card }];
  mount();
  await screen.findByText("Card ending 1234");
  expect(screen.getByText(/by Staff Example/)).toBeTruthy();
  cards[12] = [{ ...card, label: "Updated card" }];
  await userEvent.click(screen.getByRole("button", { name: "Refresh cards" }));
  expect(
    await screen.findByRole("heading", { name: "Updated card" }),
  ).toBeTruthy();
});
test("tap capture is explicitly confirmed using a member-bound session and shows progress", async () => {
  let finish: () => void = () => {};
  mutation = async (path) => {
    if (path === "/admin/access/enrollments")
      return {
        id: "scan-one",
        readerId: "front",
        userId: 12,
        purpose: "assign",
        status: "waiting",
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      } satisfies CardScan;
    if (path === "/admin/access/cards")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return {};
  };
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Start card scan" }),
  );
  await screen.findByText("Card captured · ending 7788");
  expect(screen.queryByLabelText("NFC card ID")).toBeNull();
  await userEvent.type(screen.getByLabelText("Card label"), "Scanned card");
  await userEvent.type(
    screen.getByLabelText("Assignment reason"),
    "Verified cardholder",
  );
  await userEvent.click(screen.getByRole("button", { name: "Assign card" }));
  expect(
    (
      screen.getByRole("button", {
        name: "Assigning card…",
      }) as HTMLButtonElement
    ).disabled ||
      screen
        .getByRole("button", { name: "Assigning card…" })
        .matches(":disabled"),
  ).toBe(true);
  expect(api).toHaveBeenCalledWith("/admin/access/cards", {
    method: "POST",
    body: {
      userId: 12,
      enrollmentId: "scan-one",
      label: "Scanned card",
      reason: "Verified cardholder",
    },
  });
  finish();
  expect(await screen.findByText(/NFC card assigned to Jordan/)).toBeTruthy();
});
test("changing member cancels a captured scan and removes confirmation controls", async () => {
  mutation = async () =>
    ({
      id: "scan-one",
      readerId: "front",
      userId: 12,
      purpose: "assign",
      status: "waiting",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }) satisfies CardScan;
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Start card scan" }),
  );
  await screen.findByText("Card captured · ending 7788");
  await userEvent.click(screen.getByRole("button", { name: "Change member" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/admin/access/enrollments/scan-one/cancel",
      { method: "POST" },
    ),
  );
  expect(screen.queryByRole("button", { name: "Assign card" })).toBeNull();
});
test("a scan-start response arriving after the member changed is cancelled", async () => {
  let complete: (value: CardScan) => void = () => {};
  mutation = async (path) =>
    path === "/admin/access/enrollments"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : {};
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Start card scan" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Change member" }));
  complete({
    id: "late-scan",
    readerId: "front",
    userId: 12,
    purpose: "assign",
    status: "waiting",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/admin/access/enrollments/late-scan/cancel",
      { method: "POST" },
    ),
  );
  expect(screen.queryByRole("button", { name: "Assign card" })).toBeNull();
});

test("with nobody chosen, recent taps open the member's cards", async () => {
  mount("/admin/access");
  expect(screen.getByText("Find a member to view or assign their NFC cards.")).toBeTruthy();
  const list = await screen.findByRole("list");
  // Five most recent only, newest first.
  expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  const jordanRow = within(list).getByRole("link", { name: /Jordan Example/ });
  expect(jordanRow.textContent).toContain("Denied · waiver needed");
  expect(jordanRow.textContent).toContain("2 min ago");
  await userEvent.click(jordanRow);
  expect(
    await screen.findByRole("heading", { name: "NFC cards for Jordan Example" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Recent taps" })).toBeNull();
});
test("the denied filter asks the server for denied taps only", async () => {
  mount("/admin/access");
  await screen.findAllByRole("link", { name: /Alex Example/ });
  await userEvent.click(screen.getByRole("button", { name: "Denied" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/admin/access/events?result=denied",
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect(screen.queryAllByRole("link", { name: /Alex Example/ })).toHaveLength(0),
  );
  expect(screen.getByRole("link", { name: /Jordan Example/ })).toBeTruthy();
});
test("an unknown card's tap opens Find a card and looks that card up", async () => {
  mutation = async (path, body) => {
    if (path === "/admin/access/cards/lookup") {
      expect(body).toEqual({ eventId: 89 });
      return [] satisfies CardAssignment[];
    }
    return {};
  };
  mount("/admin/access");
  await userEvent.click(
    await screen.findByRole("link", { name: /Unknown card ••4F21/ }),
  );
  expect(await screen.findByRole("heading", { name: "Find a card" })).toBeTruthy();
  expect(await screen.findByText("Card from the selected tap:")).toBeTruthy();
  expect(screen.getByText("No member has been assigned this card.")).toBeTruthy();
});
