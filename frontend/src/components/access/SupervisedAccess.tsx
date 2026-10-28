import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { facilityTime, type AccessResource } from "../../lib/nfc";
import { LoadState } from "../Management";
import { Modal } from "../Modal";

type Override = {
  id: number;
  kind: string;
  resourceName: string;
  endsAt: string;
  reason: string;
  revokedAt: string | null;
};
export function SupervisedAccess({
  userId,
  memberName,
  timeZone,
}: {
  userId: number;
  memberName: string;
  timeZone: string;
}) {
  const records = useApi<Override[]>(
    `/admin/access/overrides?userId=${userId}`,
  );
  const resources = useApi<AccessResource[]>("/admin/access/resources");
  const [duration, setDuration] = useState("15"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [revoking, setRevoking] = useState<Override | null>(null);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form),
      [kind, id] = String(f.get("resource")).split(":");
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await api("/admin/access/overrides", {
        method: "POST",
        body: {
          userId,
          kind,
          resourceId: Number(id),
          durationMinutes: Number(duration),
          reason: f.get("reason"),
        },
      });
      form.reset();
      setDuration("15");
      records.reload();
      setNotice(`Supervised access created for ${memberName}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!revoking) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await api(`/admin/access/overrides/${revoking.id}/revoke`, {
        method: "POST",
        body: { reason: new FormData(e.currentTarget).get("reason") },
      });
      setNotice(`Supervised access ended for ${revoking.resourceName}.`);
      records.reload();
      setRevoking(null);
    } catch (e) {
      setError(errorMessage(e));
      records.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nfc-section" aria-label="Supervised access">
      <div className="nfc-section__heading">
        <h2>Supervised access</h2>
        <button
          className="button button--quiet"
          disabled={records.loading}
          onClick={records.reload}
        >
          {records.loading ? "Loading…" : "Refresh supervised access"}
        </button>
      </div>
      <p>
        Staff can supervise equipment or room use for up to 30 minutes.
        Membership, waivers, training and account restrictions still apply. A
        reservation is created if needed; ending supervision cancels that
        reservation.
      </p>
      <LoadState {...records} />
      {records.data?.length === 0 ? (
        <p className="empty-state">
          No supervised access has been issued for {memberName}.
        </p>
      ) : null}
      {records.data?.map((o) => (
        <article className="nfc-card" key={o.id}>
          <h3>{o.resourceName}</h3>
          <p>
            {o.revokedAt
              ? "Ended"
              : Date.parse(o.endsAt) <= Date.now()
                ? "Expired"
                : "Active"}{" "}
            · ends {facilityTime(o.endsAt, timeZone)} ({timeZone})
          </p>
          <p>{o.reason}</p>
          {!o.revokedAt && Date.parse(o.endsAt) > Date.now() ? (
            <button
              className="button button--quiet"
              onClick={() => {
                setRevoking(o);
                setError("");
                setNotice("");
              }}
            >
              End supervision for {o.resourceName}
            </button>
          ) : null}
        </article>
      ))}
      <form
        className="management-form"
        aria-label="Create supervised access"
        onSubmit={create}
      >
        <h3>Create supervised access for {memberName}</h3>
        <LoadState {...resources} />
        <fieldset disabled={busy}>
          <label>
            Equipment or room
            <select name="resource" required defaultValue="">
              <option value="">Choose equipment or a room</option>
              {resources.data
                ?.filter((r) => r.kind !== "building")
                .map((r) => (
                  <option key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`}>
                    {r.name} · {r.kind}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Duration
            <select
              name="duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              {[5, 10, 15, 30].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </label>
          <p className="nfc-help">
            Starts when saved. Maximum 30 minutes. End times use {timeZone}.
          </p>
          <label>
            Reason
            <input name="reason" required maxLength={500} />
          </label>
          <button className="button button--primary">
            {busy ? "Saving…" : "Create supervised access"}
          </button>
        </fieldset>
        {!revoking && error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="form-notice" role="status">
            {notice}{" "}
            <button
              type="button"
              className="nfc-dismiss"
              onClick={() => setNotice("")}
            >
              Dismiss
            </button>
          </p>
        ) : null}
      </form>
      <Modal
        open={!!revoking}
        title={`End supervision for ${revoking?.resourceName ?? memberName}?`}
        onClose={() => {
          if (!busy) setRevoking(null);
        }}
        width="compact"
      >
        <form className="management-form" onSubmit={revoke}>
          <p>
            This ends supervised access for {memberName} and cancels any
            reservation created for it.
          </p>
          <label>
            Reason
            <input name="reason" required maxLength={500} disabled={busy} />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="button button--primary" disabled={busy}>
            {busy ? "Ending supervision…" : "Confirm end of supervision"}
          </button>
        </form>
      </Modal>
    </section>
  );
}
