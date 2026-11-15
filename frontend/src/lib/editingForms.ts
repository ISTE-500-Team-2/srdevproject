/**
 * Staff forms whose edits background refreshes must not replace. A form opts in
 * with `ref={editingFormRef}`; useApi's polling then waits while focus is inside
 * a registered form or any of its fields differs from its default (unsaved edits).
 * Saving or resetting the form (or unmounting it) lets polling resume.
 */
const forms = new Set<HTMLFormElement>();

/** Ref callback that registers a form for as long as it is mounted. */
export function editingFormRef(form: HTMLFormElement | null) {
  if (!form) return;
  forms.add(form);
  return () => {
    forms.delete(form);
  };
}

function hasUnsavedEdits(form: HTMLFormElement) {
  return Array.from(form.elements).some(element => {
    if (element instanceof HTMLInputElement) {
      if (["submit", "button", "reset", "hidden"].includes(element.type)) return false;
      return ["checkbox", "radio"].includes(element.type)
        ? element.checked !== element.defaultChecked : element.value !== element.defaultValue;
    }
    if (element instanceof HTMLTextAreaElement) return element.value !== element.defaultValue;
    if (element instanceof HTMLSelectElement) {
      const defaults = Array.from(element.options).filter(option => option.defaultSelected);
      if (!defaults.length && !element.multiple && element.options.length) defaults.push(element.options[0]);
      return Array.from(element.selectedOptions).map(option => option.value).join("\0") !== defaults.map(option => option.value).join("\0");
    }
    return false;
  });
}

/** Whether staff is in, or has unsaved edits in, a registered form on the page. */
export function staffIsEditing() {
  const active = document.activeElement;
  return Array.from(forms).some(form => form.isConnected && ((active !== null && form.contains(active)) || hasUnsavedEdits(form)));
}
