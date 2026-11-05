// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ComplianceSummary } from "./ReportsPage";

afterEach(cleanup);
const compliance = { activeAccounts: 10, restrictedAccounts: 1, expiredTraining: 2, activeMemberships: 8, trainingWithoutExpiry: 3, signaturesWithoutCopy: 4, machinesWithoutTraining: ["Saw", "Drill"] };

test("B-013, B-014, B-016: records that need a decision are named for staff", () => {
  render(<ComplianceSummary compliance={compliance} />);
  expect(screen.getByText(/8 active memberships/)).toBeTruthy();
  expect(screen.getByText(/3 active training records have no expiry date/)).toBeTruthy();
  expect(screen.getByText(/4 signed waivers have no retained copy/)).toBeTruthy();
  expect(screen.getByText(/2 bookable machines have no training requirement: Saw, Drill/)).toBeTruthy();
});

test("nothing extra is shown when every record is in order", () => {
  render(<ComplianceSummary compliance={{ ...compliance, trainingWithoutExpiry: 0, signaturesWithoutCopy: 0, machinesWithoutTraining: [] }} />);
  expect(screen.queryByText(/no expiry date/)).toBeNull();
  expect(screen.queryByText(/no retained copy/)).toBeNull();
  expect(screen.queryByText(/no training requirement/)).toBeNull();
});
