// Owns expiring reader enrollment capture: starts/polls/cancels scans and discards results from
// superseded requests.

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type { CardScan } from "./nfc";

/**
 * When a scan ends by this browser's clock: counted from the time the server says is left, so a
 * computer whose clock is off neither expires a scan at once nor shows the wrong time remaining.
 * expiresAt alone is only a fallback.
 */
const deadlineOf = (result: CardScan, received = Date.now()) =>
  typeof result.expiresInMs === "number"
    ? received + result.expiresInMs
    : Date.parse(result.expiresAt);

/**
 * Manage a single capture session; generation checks prevent late start responses from restoring a
 * canceled scan.
 */
export function useCardScan(purpose: "assign" | "lookup", userId?: number) {
  const [scan, setScan] = useState<CardScan | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0),
    [now, setNow] = useState(Date.now());
  // When the scan ends by this browser's clock (see deadlineOf). Every answer from the server
  // resets it, so a tap that lands late in the window counts down from the time actually left.
  const [deadline, setDeadline] = useState(0);
  const active = useRef<string | null>(null),
    generation = useRef(0);
  const release = (id: string) =>
    api(`/admin/access/enrollments/${id}/cancel`, { method: "POST" }).catch(
      () => undefined,
    );
  useEffect(
    () => () => {
      generation.current++;
      if (active.current) void release(active.current);
    },
    [],
  );
  async function start(readerId: string) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<CardScan>("/admin/access/enrollments", {
        method: "POST",
        body: { readerId, purpose, ...(userId ? { userId } : {}) },
      });
      if (current !== generation.current) {
        void release(result.id);
        return;
      }
      active.current = result.id;
      const received = Date.now();
      setDeadline(deadlineOf(result, received));
      setNow(received);
      setScan(result);
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function cancel() {
    generation.current++;
    const id = active.current;
    active.current = null;
    setScan(null);
    setError("");
    setBusy(false);
    if (id) await release(id);
  }
  useEffect(() => {
    if (!scan || scan.status !== "waiting") return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<CardScan>(
          `/admin/access/enrollments/${scan.id}`,
        );
        if (!live) return;
        setDeadline(deadlineOf(result));
        setScan(result);
        setError("");
        if (result.status === "waiting") timer = setTimeout(poll, 1000);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scan?.id, scan?.status, retry]);
  // A lookup is finished once its card is captured; only an assignment still has to be
  // confirmed before the scan expires.
  const counting =
    !!scan &&
    (scan.status === "waiting" ||
      (scan.status === "captured" && purpose === "assign"));
  useEffect(() => {
    if (!scan || !counting) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline)
        setScan((s) => (s ? { ...s, status: "expired" } : s));
    };
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [scan?.id, scan?.status, deadline, counting]);
  return {
    scan,
    error,
    busy,
    /** The scan is still running against its expiry: waiting, or captured for an assignment. */
    counting,
    start,
    cancel,
    seconds: scan ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0,
    retry: () => {
      setError("");
      setRetry((n) => n + 1);
    },
  };
}
