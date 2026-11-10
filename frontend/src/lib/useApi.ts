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

/** Start the reads `route` made last time, e.g. while its session check is still running. */
export function prefetchRoute(route: string) {
  for (const path of routeReadsFor(route)) {
    markPrefetched(path);
    void loadShared(path).catch(() => {});
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

export function useApi<T>(path: string | null, options: { retainOnReload?: boolean; refreshInterval?: number; requestKey?: string | number } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const previousPath = useRef(path);
  const requestKey = options.requestKey;
  const previousKey = useRef(requestKey);
  // A resource seen earlier this session renders on the first frame; it is revalidated below.
  const [initial] = useState(() => (path !== null && requestKey === undefined ? readCache<T>(path) : undefined));
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
    const shared = arriving && requestKey === undefined;
    const cached = shared ? readCache<T>(path) : undefined;
    // Consume the mark on every arrival so a stale one can't skip a later visit's read.
    const prefetchedNow = shared && takePrefetched(path);
    if (shared) noteRouteRead(currentRoute(), path);
    if (cached) { dataRef.current = cached.data; setData(cached.data); setError(""); }
    // Prefetched for this arrival and already back (the route's session check took longer): it is current.
    if (cached && prefetchedNow && !joinInflight(path)) {
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
    loadShared<T>(path)
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
  }, [path, revision, retainOnReload, requestKey]);
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
