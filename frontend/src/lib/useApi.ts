import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
export function useApi<T>(path: string | null, options: { retainOnReload?: boolean } = {}) {
  const retainOnReload = options.retainOnReload ?? false;
  const previousPath = useRef(path);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const samePath = previousPath.current === path;
    previousPath.current = path;
    if (path === null) { setData(null); setLoading(false); setError(""); return; }
    const controller = new AbortController();
    setLoading(true);
    // Opt-in background refresh keeps keyed forms mounted. A different resource
    // or lost access must still clear the old response.
    if (!retainOnReload || !samePath) setData(null);
    setError("");
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          if (retainOnReload && error instanceof ApiError && [401, 403, 404].includes(error.status)) setData(null);
          setError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision, retainOnReload]);
  return { data, loading, error, reload };
}
