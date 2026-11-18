import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { timeOnly } from "../../../lib/display";
import type { Person } from "../../../lib/staffContracts";
import { Row, type OpenDialog } from "./recordParts";

/** A supervised-use unlock of one machine or room, as the overrides endpoint returns it. */
export type Override = { id: number; kind: string; resourceName: string; endsAt: string; reason: string; revokedAt: string | null };

/** Machines or rooms unlocked for the member while staff watch, and a way to start one. */
export function RecordSupervision({
  person: u,
  overrides,
  canManage,
  open,
}: {
  person: Pick<Person, "id" | "firstName" | "status" | "accessStatus">;
  overrides: Override[] | null;
  canManage: boolean;
  open: OpenDialog;
}) {
  const [, setTick] = useState(0);
  const liveOverrides = (overrides ?? []).filter((o) => !o.revokedAt && Date.parse(o.endsAt) > Date.now());
  // Hide each unlock, and its End button, the moment it ends. Refreshes wait while staff
  // edit a form, so they can't be relied on to do it.
  const nextEnd = Math.min(...liveOverrides.map((o) => Date.parse(o.endsAt)));
  useEffect(() => {
    if (!Number.isFinite(nextEnd)) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, nextEnd - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [nextEnd]);
  return (
    <section className="today-panel" aria-labelledby={`mr-sup-title-${u.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-sup-title-${u.id}`}>Supervised use</h2>
        {canManage ? (
          <button type="button" className="today-link" disabled={u.status !== "active" || u.accessStatus !== "active"} onClick={() => open({ kind: "supervise" })}>
            Start <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {liveOverrides.length ? (
        liveOverrides.map((o) => (
          <Row
            key={o.id}
            icon="shield"
            tone="ok"
            title={o.resourceName}
            detail={`Until ${timeOnly(o.endsAt)} · “${o.reason}”`}
            end={
              canManage ? (
                <button type="button" className="today-link" onClick={() => open({ kind: "endSupervision", override: o })}>
                  End
                </button>
              ) : null
            }
          />
        ))
      ) : (
        <p className="today-empty">
          {u.status !== "active" || u.accessStatus !== "active"
            ? "Not available while the account or access is blocked."
            : `Unlock one machine or room for ${u.firstName} for up to 30 minutes while you watch.`}
        </p>
      )}
    </section>
  );
}
