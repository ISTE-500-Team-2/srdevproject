import { expect, test } from "vitest";
import { accessReasonLabel } from "./accessReadiness";
import { shortDenial } from "../components/access/RecentTaps";

// Denials from the minor-supervision rules, passed through by the reader check as they are.
const minorDenials = ["SPONSOR_REQUIRED", "SPONSOR_INELIGIBLE", "SPONSOR_BOOKING_REQUIRED", "MINOR_CHECK_IN_REQUIRED", "BUILDING_REQUIRED"];

test("minor and sponsor denials read as guidance, not as the raw code", () => {
  for (const code of minorDenials) {
    const fallback = code.toLowerCase().replaceAll("_", " ");
    expect(accessReasonLabel(code)).not.toBe(fallback);
    expect(accessReasonLabel(code)).toMatch(/^[A-Z].*\.$/);
    expect(shortDenial(code)).not.toBe(fallback);
  }
  expect(accessReasonLabel("SPONSOR_REQUIRED")).toBe("This member is under 18. An active sponsoring adult must be linked to them and checked in at this building.");
  expect(shortDenial("MINOR_CHECK_IN_REQUIRED")).toBe("minor not checked in");
});

test("an unknown code still falls back to readable words", () => {
  expect(accessReasonLabel("SOMETHING_NEW")).toBe("something new");
  expect(shortDenial("SOMETHING_NEW")).toBe("something new");
});
