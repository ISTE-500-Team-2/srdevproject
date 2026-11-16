// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Studio } from "../../lib/studioContracts";
import { OccupancyBoard } from "./OccupancyBoard";

afterEach(cleanup);

const paris: Studio = {
  id: 7,
  name: "Paris",
  size: "large",
  monthly_cents: 65000,
  cancellation_policy: "full_before_start",
  policy_confirmed: true,
  revision: 4,
  availability: [],
};
const count = (studios: Studio[]) => {
  const { container, unmount } = render(
    <OccupancyBoard studios={studios} rentals={[]} today="2026-11-10" timeZone="America/New_York" canEdit={false} onOpen={() => undefined} />,
  );
  const text = container.querySelector(".desk-count")?.textContent;
  unmount();
  return text;
};

test("the studio count agrees with its number", () => {
  expect(count([paris])).toBe("1 studio");
  expect(count([paris, { ...paris, id: 8, name: "Big Apple" }])).toBe("2 studios");
});
