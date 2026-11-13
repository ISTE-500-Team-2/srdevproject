import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { readStored, storeResult } from "./apiCache";
import { staffIsEditing } from "./editingForms";

/** Reads a setting that is the same for everyone and keeps it for `reuse` readers (/config). */
export function loadShared<T>(path: string): Promise<T> {
  return api<T>(path).then((data) => { storeResult(path, data); return data; });
}

/**
 * `reuse: true` is only for settings that are the same for everyone and rarely
 * change (/config): a stored copy renders at once and refreshes in the background.
 */
export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; refreshInterval?: number; requestKey?: string | number; reuse?: boolean } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const reuse = options.reuse === true && options.requestKey === undefined;
  const previousPath = useRef(path);
  const requestKey = options.requestKey;
  const previousKey = useRef(requestKey);
  const [initial] = useState(() => (path !== null && reuse ? readStored<T>(path) : undefined));
  const [data, setData] = useState<T | null>(initial ? initial.data : null);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(false);
  const dataRef = useRef<T | null>(initial ? initial.data : null);
  const arrived = useRef(false);
  const fetching = useRef(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const samePath = previousPath.current === path && previousKey.current === requestKey;
    previousPath.current = path;
    previousKey.current = requestKey;
    // Mount or resource change, as opposed to reload() for the same resource.
    const arriving = !arrived.current || !samePath;
    arrived.current = true;
    if (path === null) { dataRef.current = null; setData(null); setLoading(false); setRefreshing(false); setError(""); return; }
    const controller = new AbortController();
    const kept = arriving && reuse ? readStored<T>(path) : undefined;
    if (kept) { dataRef.current = kept.data; setData(kept.data); }
    const background = kept !== undefined || (retainOnReload && samePath && dataRef.current !== null);
    fetching.current = true;
    // Loading UI is first-load/resource-change only. Background reads must not
    // insert loading banners, collapse charts, resize buttons or unmount forms.
    setLoading(!background);
    setRefreshing(background);
    if (!background) { dataRef.current = null; setData(null); }
    setError("");
    (reuse ? loadShared<T>(path) : api<T>(path, { signal: controller.signal }))
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
  }, [path, revision, retainOnReload, requestKey, reuse]);
  const refreshInterval = options.refreshInterval ?? 0;
  useEffect(() => {
    if (!path || refreshInterval <= 0) return;
    const refresh = () => {
      // Do not replace revision-keyed forms while a staff member is editing (see editingForms).
      if (fetching.current || document.visibilityState === "hidden" || staffIsEditing()) return;
      reload();
    };
    const timer = window.setInterval(refresh, refreshInterval);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [path, refreshInterval, reload]);
  return { data, loading, refreshing, error, reload };
}
