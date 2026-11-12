import { useEffect, useState } from "react";

/**
 * The latest refresh error for a result that keeps its older data on screen.
 * useApi clears `error` when a retry starts; this keeps the error until a read
 * replaces the data (or the data goes away), so a notice does not blink on retry.
 */
export function useFailure(result: { data: unknown; error: string }) {
  const [failure, setFailure] = useState<{ error: string; data: unknown } | null>(null);
  useEffect(() => {
    if (result.error) setFailure({ error: result.error, data: result.data });
  }, [result.error, result.data]);
  return result.error || (failure && result.data !== null && failure.data === result.data ? failure.error : "");
}
