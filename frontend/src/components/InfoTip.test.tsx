// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTip } from "./InfoTip";
afterEach(cleanup);

const mount = () => {
  render(<InfoTip label="What this card counts">Approved check-ins only.</InfoTip>);
  const button = screen.getByRole("button", { name: "What this card counts" });
  return { button, tip: button.parentElement! };
};

test("Escape hides a note shown by keyboard focus until focus leaves", async () => {
  const user = userEvent.setup();
  const { button, tip } = mount();
  await user.tab();
  expect(document.activeElement).toBe(button);
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
  await user.keyboard("{Escape}");
  expect(tip.hasAttribute("data-dismissed")).toBe(true);
  expect(document.activeElement).toBe(button);
  // Once focus leaves, the next visit shows the note again.
  await user.tab();
  expect(document.activeElement).not.toBe(button);
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});

test("Escape hides a note shown by hover until the pointer leaves", () => {
  const { tip } = mount();
  fireEvent.pointerEnter(tip);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(tip.hasAttribute("data-dismissed")).toBe(true);
  fireEvent.pointerLeave(tip);
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});

test("Escape closes a pinned note, which stays hidden while focused; a tap pins it again", async () => {
  const user = userEvent.setup();
  const { button, tip } = mount();
  await user.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{Escape}");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(tip.hasAttribute("data-dismissed")).toBe(true);
  await user.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});

test("after a click and Escape, the hover note returns once the pointer leaves and comes back", async () => {
  const user = userEvent.setup();
  const { button, tip } = mount();
  await user.click(button);
  expect(document.activeElement).toBe(button);
  // Sent to the page, as browsers do not count Escape as keyboard use that makes a clicked button :focus-visible.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(tip.hasAttribute("data-dismissed")).toBe(true);
  fireEvent.pointerLeave(tip);
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
  fireEvent.pointerEnter(tip);
  expect(document.activeElement).toBe(button);
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});

test("a note dismissed while keyboard-focused stays hidden after the pointer leaves", async () => {
  const user = userEvent.setup();
  const { button, tip } = mount();
  await user.tab();
  fireEvent.pointerEnter(tip);
  await user.keyboard("{Escape}");
  fireEvent.pointerLeave(tip);
  expect(document.activeElement).toBe(button);
  expect(tip.hasAttribute("data-dismissed")).toBe(true);
});

test("Escape on a pinned note the pointer has left does not hide the next hover", async () => {
  const user = userEvent.setup();
  const { button, tip } = mount();
  await user.click(button);
  fireEvent.pointerLeave(tip);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});

test("Escape does nothing while the note is not showing", () => {
  const { tip } = mount();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(tip.hasAttribute("data-dismissed")).toBe(false);
});
