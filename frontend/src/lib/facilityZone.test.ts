import { expect, test } from "vitest";
import { zonedDayStart } from "./facilityZone";

test("a facility day starts at its own midnight, across a daylight-saving change", () => {
  expect(zonedDayStart("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
  expect(zonedDayStart("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
  expect(zonedDayStart("2026-11-11", "Pacific/Auckland")).toBe("2026-11-10T11:00:00.000Z");
});
