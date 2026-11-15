import { expect, test } from "vitest";
import { dateTime } from "./display";

test("dateTime shows a timestamp in the given time zone, whatever the viewer's clock", () => {
  const at = "2026-11-12T15:30:00Z";
  expect(dateTime(at, "America/New_York")).toBe(
    new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }),
  );
  expect(dateTime(at, "America/New_York")).toMatch(/10:30/);
  expect(dateTime(at, "Asia/Tokyo")).toMatch(/12:30/);
});

test("dateTime without a time zone keeps the viewer's clock", () => {
  const at = "2026-11-12T15:30:00Z";
  expect(dateTime(at)).toBe(new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  expect(dateTime(undefined)).toBe("Not recorded");
});
