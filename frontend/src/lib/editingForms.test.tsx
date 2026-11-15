// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionForm } from "../components/Management";
import { editingFormRef, staffIsEditing } from "./editingForms";

afterEach(cleanup);

function Draft({ formKey = 1 }: { formKey?: number }) {
  return (
    <form key={formKey} ref={editingFormRef} aria-label="Draft">
      <input aria-label="Name" defaultValue="Original" />
      <select aria-label="Plan" defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <input aria-label="Agree" type="checkbox" />
      <button type="submit">Save</button>
    </form>
  );
}

test("a registered form pauses while focused or unsaved and releases on reset or unmount", () => {
  const { unmount } = render(<Draft />);
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(staffIsEditing()).toBe(false);
  name.focus();
  expect(staffIsEditing()).toBe(true);
  name.blur();
  expect(staffIsEditing()).toBe(false);
  fireEvent.change(name, { target: { value: "Changed" } });
  expect(staffIsEditing()).toBe(true);
  (screen.getByRole("form", { name: "Draft" }) as HTMLFormElement).reset();
  expect(staffIsEditing()).toBe(false);
  fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "a" } });
  expect(staffIsEditing()).toBe(true);
  unmount();
  expect(staffIsEditing()).toBe(false);
});

test("checkboxes count as unsaved edits, and a remounted form starts clean", () => {
  const { rerender } = render(<Draft formKey={1} />);
  fireEvent.click(screen.getByLabelText("Agree"));
  expect(staffIsEditing()).toBe(true);
  rerender(<Draft formKey={2} />);
  expect(staffIsEditing()).toBe(false);
});

test("a form detached from the page no longer pauses refresh", () => {
  render(<Draft />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
  expect(staffIsEditing()).toBe(true);
  document.body.innerHTML = "";
  expect(staffIsEditing()).toBe(false);
});

test("staff action forms register themselves", () => {
  render(
    <ActionForm title="Add note" submitLabel="Save" onSubmit={async () => {}}>
      <textarea aria-label="Note" name="note" />
    </ActionForm>,
  );
  expect(staffIsEditing()).toBe(false);
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Draft" } });
  expect(staffIsEditing()).toBe(true);
});
