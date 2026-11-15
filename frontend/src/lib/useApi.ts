// Shared read hook separates first-load state from background refresh and cancels obsolete reads
// when the requested resource changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { readStored, storeResult } from "./apiCache";
import { staffIsEditing } from "./editingForms";

/** Reads a setting that is the same for everyone and keeps it for `reuse` readers (/config). */
export function loadShared<T>(path: string): Promise<T> {
  return api<T>(path).then((data) => { storeResult(path, data); return data; });
}

const requestId = (path: string, key: string | number | undefined) => JSON.stringify([path, key ?? null]);

/**
 * `reuse: true` is only for settings that are the same for everyone and rarely
 * change (/config): a stored copy renders at once and refreshes in the background.
 * `retainOnChange: true` is for another page or filter of the same list: the last
 * results stay on screen, reported as refreshing and `stale`, until the new ones land.
 */
export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; retainOnChange?: boolean; refreshInterval?: number; requestKey?: string | number; reuse?: boolean } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const retainOnChange = options.retainOnChange ?? false;
  const reuse = options.reuse === true && options.requestKey === undefined;
  const previousPath = useRef(path);
  const requestKey = options.requestKey;
  const previousKey = useRef(requestKey);
  const [initial] = useState(() => (path !== null && reuse ? readStored<T>(path) : undefined));
  const [data, setData] = useState<T | null>(initial ? initial.data : null);
  // The request the data answers; with retainOnChange it can be an earlier page or filter.
  const [dataFor, setDataFor] = useState<string | null>(initial && path !== null ? requestId(path, requestKey) : null);
  const dataForRef = useRef(dataFor);
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
    const show = (value: T | null, answers: string | null) => {
      dataRef.current = value; dataForRef.current = answers; setData(value); setDataFor(answers);
    };
    if (path === null) { show(null, null); setLoading(false); setRefreshing(false); setError(""); return; }
    const id = requestId(path, requestKey);
    const controller = new AbortController();
    const kept = arriving && reuse ? readStored<T>(path) : undefined;
    if (kept) show(kept.data, id);
    // Data on screen either answers this very request (a reload) or an earlier page or filter.
    const current = dataRef.current !== null && dataForRef.current === id;
    const background = kept !== undefined || (dataRef.current !== null && (current ? retainOnReload : retainOnChange));
    fetching.current = true;
    // Loading UI is first-load/resource-change only. Background reads must not
    // insert loading banners, collapse charts, resize buttons or unmount forms.
    setLoading(!background);
    setRefreshing(background);
    if (!background) show(null, null);
    setError("");
    (reuse ? loadShared<T>(path) : api<T>(path, { signal: controller.signal }))
      .then((result) => {
        if (!controller.signal.aborted) show(result, id);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          // Kept results must not stay under a request they do not answer.
          const lostAccess = retainOnReload && error instanceof ApiError && [401, 403, 404].includes(error.status);
          if (lostAccess || (retainOnChange && !current)) show(null, null);
          setError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) { fetching.current = false; setLoading(false); setRefreshing(false); }
      });
    return () => { controller.abort(); fetching.current = false; };
  }, [path, revision, retainOnReload, retainOnChange, requestKey, reuse]);
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
  // Kept results from an earlier page or filter: show them, but don't let anyone act on them.
  const stale = data !== null && path !== null && dataFor !== requestId(path, requestKey);
  return { data, loading, refreshing, stale, error, reload };
}
