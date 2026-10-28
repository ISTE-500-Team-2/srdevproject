import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type { CardScan } from "./nfc";

export function useCardScan(purpose: "assign" | "lookup", userId?: number) {
  const [scan, setScan] = useState<CardScan | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0),
    [now, setNow] = useState(Date.now());
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
      setScan(result);
      setNow(Date.now());
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
  useEffect(() => {
    if (!scan || !["waiting", "captured"].includes(scan.status)) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= Date.parse(scan.expiresAt))
        setScan((s) => (s ? { ...s, status: "expired" } : s));
    };
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [scan?.id, scan?.status, scan?.expiresAt]);
  return {
    scan,
    error,
    busy,
    start,
    cancel,
    seconds: scan
      ? Math.max(0, Math.ceil((Date.parse(scan.expiresAt) - now) / 1000))
      : 0,
    retry: () => {
      setError("");
      setRetry((n) => n + 1);
    },
  };
}
