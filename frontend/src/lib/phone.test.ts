import { expect, test } from "vitest";
import { phoneDigits, phoneProblem } from "./phone";

test.each(["(410) 555-0182", "+1 (410) 555-0182", "410.555.0182", "555-0182", "+44 20 7946 0958"])("%s can be saved", (value) => {
  expect(phoneProblem(value)).toBe("");
});

test.each(["call me", "555-018", "+1 (410) 555-0182 ext 4", "1234567890123456", ""])("%s can't be saved", (value) => {
  expect(phoneProblem(value)).toContain("7 to 15 digits");
});

test("only the digits are saved", () => {
  expect(phoneDigits("+1 (410) 555-0182")).toBe("14105550182");
});
