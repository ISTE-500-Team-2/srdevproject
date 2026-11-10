import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { addPrefetch, noteRouteRead, prefetchFor, readStored, routeReadsFor, storeResult, type PrefetchMark } from "./apiCache";

/** Reads a setting that is the same for everyone and keeps it for `reuse` readers (/config). */
export function loadShared<T>(path: string): Promise<T> {
  return api<T>(path).then((data) => { storeResult(path, data); return data; });
}

const currentRoute = () => window.location.pathname + window.location.search;
/** A finished prefetch older than this never stands in for the arriving page's read. */
const PREFETCH_CURRENT_MS = 5000;

/** Start the reads `route` made last time, while its session check is still running. Each is a new request. */
export function prefetchRoute(route: string) {
  for (const path of routeReadsFor(route)) {
    const promise = api(path);
    const mark = addPrefetch(path, route, promise);
    promise.then(
      (data) => { mark.ok = true; mark.data = data; mark.settledAt = Date.now(); },
      () => { mark.ok = false; },
    );
  }
}

/** A prefetch started for this page's arrival that it may use: not failed, not stale, accepted by start time. */
function arrivalPrefetch(path: string, accept: ((startedAt: number) => boolean) | undefined): PrefetchMark | undefined {
  const mark = prefetchFor(path);
  if (!mark || mark.ok === false || mark.route !== currentRoute()) return undefined;
  if (mark.ok && Date.now() - mark.settledAt! >= PREFETCH_CURRENT_MS) return undefined;
  if (accept && !accept(mark.startedAt)) return undefined;
  return mark;
}
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

/**
 * Every read is the hook's own request, as before, with one exception at arrival:
 * if the route check started this read for this page (see prefetchRoute), the hook
 * uses that request: its result if it is back, or waits for it. `acceptPrefetch`
 * can restrict which prefetch may stand in by when it started (e.g. the same day).
 * `reuse: true` is only for settings that are the same for everyone and rarely
 * change (/config): a stored copy renders at once and refreshes in the background.
 * `cache: false` and `requestKey` reads never use a prefetch.
 */
export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; refreshInterval?: number; requestKey?: string | number; cache?: boolean; reuse?: boolean; acceptPrefetch?: (startedAt: number) => boolean } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const shareable = options.cache !== false && options.requestKey === undefined;
  const reuse = shareable && options.reuse === true;
  const acceptPrefetch = useRef(options.acceptPrefetch);
  acceptPrefetch.current = options.acceptPrefetch;
  const previousPath = useRef(path);
  const requestKey = options.requestKey;
  const previousKey = useRef(requestKey);
  // A finished arrival prefetch (or a reusable setting) renders on the first frame.
  const [initial] = useState(() => {
    if (path === null || !shareable) return undefined;
    if (reuse) return readStored<T>(path);
    const mark = arrivalPrefetch(path, options.acceptPrefetch);
    return mark?.ok ? { data: mark.data as T } : undefined;
  });
  const [data, setData] = useState<T | null>(initial ? initial.data : null);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(false);
  const dataRef = useRef<T | null>(initial ? initial.data : null);
  const fetching = useRef(false);
  const arrived = useRef(false);
  /** What an arrival prefetch supplied, so a replayed effect (StrictMode) keeps it instead of reloading. */
  const served = useRef<{ key: string; data: T } | null>(null);
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
    if (path === null) { served.current = null; dataRef.current = null; setData(null); setLoading(false); setRefreshing(false); setError(""); return; }
    const key = JSON.stringify([path, requestKey ?? null, revision]);
    if (served.current?.key === key) {
      dataRef.current = served.current.data; setData(served.current.data); setError("");
      fetching.current = false; setLoading(false); setRefreshing(false);
      return;
    }
    served.current = null;
    const controller = new AbortController();
    if (arriving && shareable) noteRouteRead(currentRoute(), path);
    const mark = arriving && shareable && !reuse ? arrivalPrefetch(path, acceptPrefetch.current) : undefined;
    if (mark?.ok) {
      served.current = { key, data: mark.data as T };
      dataRef.current = served.current.data; setData(served.current.data); setError("");
      fetching.current = false; setLoading(false); setRefreshing(false);
      return;
    }
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
    const read = mark ? (mark.promise as Promise<T>) : reuse ? loadShared<T>(path) : api<T>(path, { signal: controller.signal });
    read
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
  }, [path, revision, retainOnReload, requestKey, shareable, reuse]);
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
