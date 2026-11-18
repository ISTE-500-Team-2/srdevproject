// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

test("the filter chips are never hidden, so a filter chosen on a narrow screen can always be cleared", () => {
  const css = postcss.parse(readFileSync(join(__dirname, "../../pages/studios.css"), "utf8"));
  const hiding: string[] = [];
  css.walkDecls("display", (decl) => {
    const rule = decl.parent as Rule;
    if (rule.selectors?.some((s) => s.includes(".desk-filters")) && decl.value.startsWith("none")) hiding.push(rule.selector);
  });
  expect(hiding).toEqual([]);

  render(
    <OccupancyBoard
      studios={[paris, { ...paris, id: 8, name: "Big Apple", monthly_cents: null, policy_confirmed: false }]}
      rentals={[]}
      today="2026-11-10"
      timeZone="America/New_York"
      canEdit={false}
      onOpen={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Not offered/ }));
  expect(screen.queryByText("Paris")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  expect(screen.getByText("Paris")).toBeTruthy();
});
