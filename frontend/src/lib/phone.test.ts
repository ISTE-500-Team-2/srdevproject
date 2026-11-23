import { expect, test } from "vitest";
import { phoneDigits, phoneProblem, savedPhone } from "./phone";

test.each(["(410) 555-0182", "+1 (410) 555-0182", "410.555.0182", "555-0182", "+44 20 7946 0958"])("%s can be saved", (value) => {
  expect(phoneProblem(value)).toBe("");
});

test.each(["call me", "555-018", "+1 (410) 555-0182 ext 4", "1234567890123456", ""])("%s can't be saved", (value) => {
  expect(phoneProblem(value)).toContain("7 to 15 digits");
});

test("the digits are saved, after a + when the number starts with one", () => {
  expect(phoneDigits("+1 (410) 555-0182")).toBe("14105550182");
  expect(savedPhone("(410) 555-0182")).toBe("4105550182");
  expect(savedPhone("+1 (410) 555-0182")).toBe("+14105550182");
  expect(savedPhone(" +49 30 123456")).toBe("+4930123456");
});

test("a + only leads, and with it the number still fits the 15-character column", () => {
  expect(phoneProblem("1+410 555 0182")).toContain("7 to 15 digits");
  expect(phoneProblem("+12345678901234")).toBe("");
  expect(phoneProblem("+123456789012345")).toContain("too long");
});
