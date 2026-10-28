import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { accessReasonLabel } from "../../lib/accessReadiness";
import {
  facilityTime,
  type CardAssignment,
  type ReaderSetup,
} from "../../lib/nfc";
import { LoadState } from "../Management";
import { AssignmentResults } from "./CardLookup";

type Tap = {
  id: number;
  readerId: string;
  readerName: string;
  userId: number | null;
  memberName: string | null;
  last4: string | null;
  allowed: boolean;
  reason: string;
  createdAt: string;
};
export function TapHistory({
  setup,
  userId,
}: {
  setup: ReaderSetup;
  userId?: number;
}) {
  const [reader, setReader] = useState(""),
    [result, setResult] = useState("all"),
    [pages, setPages] = useState<(number | null)[]>([null]);
  const [lookup, setLookup] = useState<{
      id: number;
      assignments: CardAssignment[];
    } | null>(null),
    [busy, setBusy] = useState<number | null>(null),
    [error, setError] = useState("");
  const params = new URLSearchParams({ result });
  if (reader) params.set("readerId", reader);
  if (userId) params.set("userId", String(userId));
  if (pages.at(-1)) params.set("before", String(pages.at(-1)));
  const events = useApi<{ items: Tap[]; nextBefore: number | null }>(
    `/admin/access/events?${params}`,
  );
  async function findCard(id: number) {
    setBusy(id);
    setError("");
    setLookup(null);
    try {
      setLookup({
        id,
        assignments: await api<CardAssignment[]>("/admin/access/cards/lookup", {
          method: "POST",
          body: { eventId: id },
        }),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="nfc-section" aria-label="Tap history">
      <div className="nfc-section__heading">
        <h2>Tap history</h2>
        <button
          className="button button--quiet"
          disabled={events.loading}
          onClick={() => {
            setPages([null]);
            events.reload();
            setLookup(null);
            setError("");
          }}
        >
          {events.loading ? "Loading taps…" : "Refresh taps"}
        </button>
      </div>
      <p className="nfc-help">
        Recent physical taps, including denied and unknown cards. Times are
        shown in {setup.timeZone}.
      </p>
      <div className="nfc-filters">
        <label>
          Reader
          <select
            value={reader}
            onChange={(e) => {
              setReader(e.target.value);
              setPages([null]);
              setLookup(null);
            }}
          >
            <option value="">All readers</option>
            {setup.readers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tap result
          <select
            value={result}
            onChange={(e) => {
              setResult(e.target.value);
              setPages([null]);
              setLookup(null);
            }}
          >
            <option value="all">All results</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
            <option value="unknown">Unknown cards</option>
          </select>
        </label>
      </div>
      <LoadState {...events} />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {events.data?.items.length === 0 ? (
        <p className="empty-state">
          No taps match these filters. Tap an NFC card at a connected reader,
          then refresh.
        </p>
      ) : null}
      <div className="nfc-taps">
        {events.data?.items.map((t) => (
          <article className="nfc-tap" key={t.id}>
            <div className="nfc-section__heading">
              <h3>{t.readerName}</h3>
              <span
                className={`activity-badge is-${t.allowed ? "allowed" : "denied"}`}
              >
                {t.allowed ? "Allowed" : "Denied"}
              </span>
            </div>
            <p>
              {t.memberName ? (
                <Link to={`/admin/access?member=${t.userId}`}>
                  {t.memberName}
                </Link>
              ) : (
                "Unknown card"
              )}
              {t.last4 ? ` · Card ending ${t.last4}` : ""}
            </p>
            <p>{accessReasonLabel(t.reason)}</p>
            <p className="nfc-help">
              {facilityTime(t.createdAt, setup.timeZone)}
            </p>
            {t.last4 ? (
              <button
                className="button button--quiet"
                disabled={busy !== null}
                onClick={() => void findCard(t.id)}
              >
                {busy === t.id ? "Looking up card…" : "Look up this card"}
              </button>
            ) : null}
            {lookup?.id === t.id ? (
              <AssignmentResults assignments={lookup.assignments} />
            ) : null}
          </article>
        ))}
      </div>
      {pages.length > 1 || events.data?.nextBefore ? (
        <div className="management-actions">
          <button
            className="button button--quiet"
            disabled={pages.length === 1 || events.loading}
            onClick={() => {
              setPages((p) => p.slice(0, -1));
              setLookup(null);
            }}
          >
            Newer taps
          </button>
          <button
            className="button button--quiet"
            disabled={!events.data?.nextBefore || events.loading}
            onClick={() => {
              setPages((p) => [...p, events.data?.nextBefore ?? null]);
              setLookup(null);
            }}
          >
            Older taps
          </button>
        </div>
      ) : null}
    </section>
  );
}
