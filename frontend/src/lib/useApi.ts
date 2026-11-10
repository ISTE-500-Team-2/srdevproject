import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { cacheGeneration, evictCache, joinInflight, markPrefetched, noteRouteRead, readCache, routeReadsFor, takePrefetched, trackInflight, writeCache } from "./apiCache";

/** One shared GET: joins an identical read already in flight and stores the result for later visits. */
export function loadShared<T>(path: string): Promise<T> {
  const joined = joinInflight<T>(path);
  if (joined) return joined;
  const startedAt = cacheGeneration();
  const promise = api<T>(path).then(
    (data) => { writeCache(path, data, startedAt); return data; },
    (error) => {
      // Never keep showing a resource the server no longer grants or has.
      if ([401, 403, 404].includes((error as { status?: number } | null)?.status ?? 0)) evictCache(path);
      throw error;
    },
  );
  trackInflight(path, promise);
  return promise;
}

const currentRoute = () => window.location.pathname + window.location.search;
/** A successful prefetch this recent stands in for the arriving page's own read. */
const PREFETCH_CURRENT_MS = 5000;

/** Start the reads `route` made last time, e.g. while its session check is still running. */
export function prefetchRoute(route: string) {
  for (const path of routeReadsFor(route)) {
    const mark = markPrefetched(path);
    void loadShared(path).then(
      () => { mark.ok = true; mark.settledAt = Date.now(); },
      () => { mark.ok = false; },
    );
  }
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
 * `cache: false` always waits for a fresh read: use it for records behind
 * editable revision-keyed forms (a cached revision could be replaced mid-edit)
 * and for verdicts whose validity is timed from when they arrive.
 * A `requestKey` read is likewise private to its caller.
 */
export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; refreshInterval?: number; requestKey?: string | number; cache?: boolean } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const shareable = options.cache !== false && options.requestKey === undefined;
  const previousPath = useRef(path);
  const requestKey = options.requestKey;
  const previousKey = useRef(requestKey);
  // A resource seen earlier this session renders on the first frame; it is revalidated below.
  const [initial] = useState(() => (path !== null && shareable ? readCache<T>(path) : undefined));
  const [data, setData] = useState<T | null>(initial ? initial.data : null);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(false);
  const dataRef = useRef<T | null>(initial ? initial.data : null);
  const fetching = useRef(false);
  const arrived = useRef(false);
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
    const shared = arriving && shareable;
    const cached = shared ? readCache<T>(path) : undefined;
    // Consume the mark on every arrival so a stale one can't skip a later visit's read.
    const prefetch = shared ? takePrefetched(path) : undefined;
    if (shared) noteRouteRead(currentRoute(), path);
    if (cached) { dataRef.current = cached.data; setData(cached.data); setError(""); }
    // Prefetched for this arrival and already back successfully (the route's session
    // check took longer): it is current. A failed or pending prefetch never stands in.
    if (cached && prefetch?.ok && Date.now() - prefetch.settledAt! < PREFETCH_CURRENT_MS && !joinInflight(path)) {
      fetching.current = false; setLoading(false); setRefreshing(false);
      return;
    }
    const background = cached !== undefined || (retainOnReload && samePath && dataRef.current !== null);
    fetching.current = true;
    // Loading UI is first-load/resource-change only. Background reads must not
    // insert loading banners, collapse charts, resize buttons or unmount forms.
    setLoading(!background);
    setRefreshing(background);
    if (!background) { dataRef.current = null; setData(null); }
    setError("");
    (shareable ? loadShared<T>(path) : api<T>(path, { signal: controller.signal }))
      .then((result) => {
        if (!controller.signal.aborted) { dataRef.current = result; setData(result); }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          if ((retainOnReload || cached) && error instanceof ApiError && [401, 403, 404].includes(error.status)) { dataRef.current = null; setData(null); }
          setError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) { fetching.current = false; setLoading(false); setRefreshing(false); }
      });
    return () => { controller.abort(); fetching.current = false; };
  }, [path, revision, retainOnReload, requestKey, shareable]);
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
