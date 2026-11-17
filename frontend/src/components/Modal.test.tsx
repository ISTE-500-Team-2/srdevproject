// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Modal } from "./Modal";
import userEvent from "@testing-library/user-event";
afterEach(cleanup);
test("Tab and Shift+Tab stay in dialog; closing restores trigger and background state", async () => {
  const user = userEvent.setup();
  const view = render(<button>Open booking</button>);
  const trigger = screen.getByRole("button");
  trigger.focus();
  view.rerender(
    <>
      <button>Open booking</button>
      <Modal open title="Booking" onClose={() => {}}>
        <input aria-label="Booking name" />
        <button>Save booking</button>
      </Modal>
    </>,
  );
  const close = screen.getByRole("button", { name: "Close dialog" }),
    save = screen.getByRole("button", { name: "Save booking" });
  expect(document.activeElement).toBe(close);
  expect(view.container.inert).toBe(true);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(save);
  await user.tab();
  expect(document.activeElement).toBe(close);
  for (let i = 0; i < 15; i++) {
    await user.tab();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
  }
  view.rerender(
    <>
      <button>Open booking</button>
      <Modal open={false} title="Booking" onClose={() => {}}>
        Details
      </Modal>
    </>,
  );
  expect(document.activeElement).toBe(trigger);
  expect(view.container.inert).not.toBe(true);
});
test("nested dialogs preserve scroll lock and restore the parent dialog before background", () => {
  const view = render(
    <>
      <Modal open title="Parent" onClose={() => {}}>
        <button>Parent action</button>
      </Modal>
      <Modal open={false} title="Child" onClose={() => {}}>
        Child
      </Modal>
    </>,
  );
  const parent = screen.getByRole("button", { name: "Parent action" });
  parent.focus();
  view.rerender(
    <>
      <Modal open title="Parent" onClose={() => {}}>
        <button>Parent action</button>
      </Modal>
      <Modal open title="Child" onClose={() => {}}>
        Child
      </Modal>
    </>,
  );
  expect(document.body.classList.contains("modal-open")).toBe(true);
  view.rerender(
    <>
      <Modal open title="Parent" onClose={() => {}}>
        <button>Parent action</button>
      </Modal>
      <Modal open={false} title="Child" onClose={() => {}}>
        Child
      </Modal>
    </>,
  );
  expect(document.body.classList.contains("modal-open")).toBe(true);
  expect(document.activeElement).toBe(parent);
});
test("modal escapes transformed page stacking context and keeps its controls interactive", () => {
  const close = vi.fn();
  const confirm = vi.fn();
  const view = render(
    <div style={{ transform: "translateY(0)" }}>
      <Modal open title="Reserve equipment" onClose={close}>
        <button onClick={confirm}>Confirm reservation</button>
      </Modal>
    </div>,
  );
  const dialog = screen.getByRole("dialog");
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  fireEvent.click(screen.getByText("Confirm reservation"));
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
test("closed modal leaves no body overlay or scroll lock", () => {
  const view = render(
    <Modal open title="Booking" onClose={() => {}}>
      Details
    </Modal>,
  );
  expect(document.body.classList.contains("modal-open")).toBe(true);
  view.rerender(
    <Modal open={false} title="Booking" onClose={() => {}}>
      Details
    </Modal>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.classList.contains("modal-open")).toBe(false);
});

test("parent updates preserve form focus while Escape uses the current close handler", () => {
  const first = vi.fn(),
    latest = vi.fn();
  const view = render(
    <Modal open title="Signup" onClose={first}>
      <input aria-label="First name" />
    </Modal>,
  );
  const input = screen.getByLabelText("First name");
  input.focus();
  fireEvent.change(input, { target: { value: "Signup" } });
  view.rerender(
    <Modal open title="Signup" onClose={latest}>
      <input aria-label="First name" />
    </Modal>,
  );
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("Signup");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(latest).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

test.each(["close", "backdrop", "Escape", "footer"])("dirty drafts survive %s dismissal until discard is confirmed", async (method) => {
  const close = vi.fn();
  render(
    <Modal open title="Edit waiver" dirty onClose={close}>
      {(requestClose) => <><input aria-label="Wording" defaultValue="Unsaved wording" /><button onClick={requestClose}>Cancel editing</button></>}
    </Modal>,
  );
  const editor = screen.getByRole("dialog", { name: "Edit waiver" });
  const input = within(editor).getByLabelText("Wording");
  input.focus();
  if (method === "close") fireEvent.click(within(editor).getByLabelText("Close dialog"));
  else if (method === "backdrop") fireEvent.mouseDown(editor.parentElement!);
  else if (method === "footer") fireEvent.click(within(editor).getByText("Cancel editing"));
  else fireEvent.keyDown(window, { key: "Escape" });
  const confirmation = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
  expect(input).toHaveProperty("value", "Unsaved wording");
  expect(editor.parentElement?.inert).not.toBe(true);
  expect(document.body.classList.contains("modal-open")).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(close).toHaveBeenCalledOnce();
});

test("pending saves cannot be dismissed and clean forms close without a discard prompt", () => {
  const close = vi.fn();
  const view = render(<Modal open title="Saving" dirty dismissible={false} onClose={close}>Draft</Modal>);
  expect(screen.getByRole("button", { name: "Close dialog" })).toHaveProperty("disabled", true);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  view.rerender(<Modal open title="Saving" onClose={close}>Saved</Modal>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("a field marked autoFocus keeps focus, and closing returns focus to the opener", () => {
  const view = render(<button>Switch account</button>);
  const trigger = screen.getByRole("button");
  trigger.focus();
  view.rerender(
    <>
      <button>Switch account</button>
      <Modal open title="Whose account?" onClose={() => {}}>
        <input aria-label="Search members" autoFocus />
      </Modal>
    </>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Search members"));
  view.rerender(
    <>
      <button>Switch account</button>
      <Modal open={false} title="Whose account?" onClose={() => {}}>
        <input aria-label="Search members" autoFocus />
      </Modal>
    </>,
  );
  expect(document.activeElement).toBe(trigger);
});

test("Tab reaches disclosure summaries after the last form control, skipping what closed ones hold", () => {
  const view = render(
    <Modal open title="Member record" onClose={() => {}}>
      <label>
        <input type="checkbox" /> Show system details
      </label>
      <details>
        <summary>Technical details</summary>
        <button>Copy record id</button>
      </details>
    </Modal>,
  );
  const close = screen.getByRole("button", { name: "Close dialog" });
  const checkbox = screen.getByRole("checkbox");
  const summary = screen.getByText("Technical details");
  // Tab from the checkbox is left to the browser, which moves on to the summary.
  checkbox.focus();
  expect(fireEvent.keyDown(checkbox, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(checkbox);
  // The summary is the last stop: the button inside the closed disclosure can't take focus.
  close.focus();
  expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(summary);
  expect(fireEvent.keyDown(summary, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(close);
  view.rerender(
    <Modal open title="Member record" onClose={() => {}}>
      <label>
        <input type="checkbox" /> Show system details
      </label>
      <details open>
        <summary>Technical details</summary>
        <button>Copy record id</button>
      </details>
    </Modal>,
  );
  expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy record id" }));
});

test("a status message on the page stays announced and dismissible while a dialog is open", () => {
  const region = document.createElement("div");
  region.setAttribute("role", "status");
  region.setAttribute("data-live-region", "");
  document.body.append(region);
  const view = render(<Modal open title="Booking" onClose={() => {}}>Details</Modal>);
  expect(view.container.inert).toBe(true);
  expect(region.inert).not.toBe(true);
  view.unmount();
  region.remove();
});
