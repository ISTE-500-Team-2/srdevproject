import { expect, test } from "vitest";
import { adminSections, legacyAdminPath } from "./sections";

test("old ?tab= workspace links land on the matching section", () => {
  expect(legacyAdminPath("?tab=members")).toBe("/admin/members");
  expect(legacyAdminPath("?tab=adminCertWaiver&section=waivers")).toBe("/admin/certifications?section=waivers");
  expect(legacyAdminPath("?tab=audit")).toBe("/admin/change-log");
  expect(legacyAdminPath("?tab=policies")).toBe("/admin/certifications?section=waivers");
  expect(legacyAdminPath("?tab=compliance")).toBe("/admin/certifications?section=compliance");
  expect(legacyAdminPath("?tab=training")).toBe("/admin/certifications?section=certifications");
  expect(legacyAdminPath("?tab=nonsense")).toBe("/admin");
  expect(legacyAdminPath("")).toBeNull();
  expect(legacyAdminPath("?section=waivers")).toBeNull();
});

test("every section has a unique path and old tab key", () => {
  expect(new Set(adminSections.map((s) => s.path)).size).toBe(adminSections.length);
  expect(new Set(adminSections.map((s) => s.legacyTab)).size).toBe(adminSections.length);
});
