// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ScheduleClassDialog } from "./ScheduleClassDialog";

vi.mock("../../lib/useApi", () => ({
  useApi: () => ({ data: null, loading: false, refreshing: false, stale: false, error: "", reload: () => {} }),
}));
afterEach(cleanup);

const mount = (onClose: () => void) =>
  render(
    <MemoryRouter>
      <ScheduleClassDialog seed={{}} onDirty={vi.fn()} onClose={onClose} onPublished={vi.fn()} />
    </MemoryRouter>,
  );

test("Escape on a started class draft asks before throwing it away", () => {
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Intro to welding" } });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Intro to welding");
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("an untouched dialog closes on Escape straight away", () => {
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Cancel on a started draft asks too", () => {
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Intro to welding" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
