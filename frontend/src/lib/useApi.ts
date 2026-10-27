import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
function hasUnsavedManagementEdits() {
  return Array.from(document.querySelectorAll<HTMLFormElement>("form.management-form")).some(form =>
    Array.from(form.elements).some(element => {
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
    }));
}

export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; refreshInterval?: number } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const previousPath = useRef(path);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const dataRef = useRef<T | null>(null);
  const fetching = useRef(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const samePath = previousPath.current === path;
    previousPath.current = path;
    if (path === null) { dataRef.current = null; setData(null); setLoading(false); setRefreshing(false); setError(""); return; }
    const controller = new AbortController();
    const background = retainOnReload && samePath && dataRef.current !== null;
    fetching.current = true;
    // Loading UI is first-load/resource-change only. Background reads must not
    // insert loading banners, collapse charts, resize buttons or unmount forms.
    setLoading(!background);
    setRefreshing(background);
    if (!background) { dataRef.current = null; setData(null); }
    setError("");
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) { dataRef.current = result; setData(result); }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          if (retainOnReload && error instanceof ApiError && [401, 403, 404].includes(error.status)) { dataRef.current = null; setData(null); }
          setError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) { fetching.current = false; setLoading(false); setRefreshing(false); }
      });
    return () => { controller.abort(); fetching.current = false; };
  }, [path, revision, retainOnReload]);
  const refreshInterval = options.refreshInterval ?? 0;
  useEffect(() => {
    if (!path || refreshInterval <= 0) return;
    const refresh = () => {
      // Do not replace revision-keyed forms while a staff member is editing.
      if (fetching.current || document.visibilityState === "hidden" || document.activeElement?.closest("form.management-form") || hasUnsavedManagementEdits()) return;
      reload();
    };
    const timer = window.setInterval(refresh, refreshInterval);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [path, refreshInterval, reload]);
  return { data, loading, refreshing, error, reload };
}
