// @vitest-environment jsdom
import { expect, test } from "vitest";
import { suggestVersion } from "./StaffPolicies";

test("next version: dated versions take the start date, numbered ones count up", () => {
  expect(suggestVersion("2026-09-28", "2026-10-30")).toBe("2026-10-30");
  expect(suggestVersion("DEMO-1", "2026-10-30")).toBe("DEMO-2");
  expect(suggestVersion("v9", "2026-10-30")).toBe("v10");
  expect(suggestVersion("Spring edition", "2026-10-30")).toBe("2026-10-30");
  expect(suggestVersion(undefined, "2026-10-30")).toBe("2026-10-30");
});
