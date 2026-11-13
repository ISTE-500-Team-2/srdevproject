import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../lib/api";
import { editingFormRef } from "../../lib/editingForms";
import { dateTime } from "../../lib/display";
import { useCardScan } from "../../lib/useCardScan";
import { uidHelp, type CardAssignment, type ReaderSetup } from "../../lib/nfc";
import { ScanControls } from "./ScanControls";

export function AssignmentResults({
  assignments,
}: {
  assignments: CardAssignment[];
}) {
  return (
    <div className="nfc-lookup-results" role="status">
      {assignments.length ? (
        assignments.map((a) => (
          <p key={a.id}>
            <strong>
              {a.active ? "Currently assigned" : "Previous assignment"}:{" "}
              {a.memberName}
            </strong>
            <br />
            {a.label} · {dateTime(a.assignedAt)} ·{" "}
            <Link to={`/admin/access?member=${a.userId}`}>
              Open {a.memberName}’s cards
            </Link>
          </p>
        ))
      ) : (
        <p>No member has been assigned this card.</p>
      )}
    </div>
  );
}
export function CardLookup({
  setup,
  tapId,
}: {
  setup: ReaderSetup;
  /** Look up the card from this tap as soon as the page opens. */
  tapId?: number;
}) {
  const scan = useCardScan("lookup");
  const [results, setResults] = useState<CardAssignment[] | null>(null),
    [fromTap, setFromTap] = useState(false),
    [busy, setBusy] = useState(tapId !== undefined),
    [error, setError] = useState("");
  useEffect(() => {
    if (tapId === undefined) return;
    let current = true;
    api<CardAssignment[]>("/admin/access/cards/lookup", {
      method: "POST",
      body: { eventId: tapId },
    })
      .then((found) => {
        if (current) {
          setResults(found);
          setFromTap(true);
        }
      })
      .catch((e) => current && setError(errorMessage(e)))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, [tapId]);
  async function lookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResults(null);
    setFromTap(false);
    try {
      setResults(
        await api<CardAssignment[]>("/admin/access/cards/lookup", {
          method: "POST",
          body: { uid: new FormData(e.currentTarget).get("uid") },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nfc-section" aria-label="Find a card">
      <h2>Find a card</h2>
      <p>
        Use a reader to identify a found NFC card and see its current and
        previous assignments.
      </p>
      <ScanControls setup={setup} scan={scan} />
      {scan.scan?.status === "captured" ? (
        <AssignmentResults assignments={scan.scan.assignments ?? []} />
      ) : null}
      {setup.configured && !scan.scan ? (
        <details>
          <summary>Look up a card ID manually</summary>
          <form ref={editingFormRef} className="management-form" onSubmit={lookup}>
            <label>
              NFC card ID
              <input
                name="uid"
                required
                autoComplete="off"
                maxLength={40}
                aria-describedby="lookup-uid-help"
              />
            </label>
            <p id="lookup-uid-help" className="nfc-help">
              {uidHelp}
            </p>
            <button className="button button--quiet" disabled={busy}>
              {busy ? "Looking up card…" : "Look up card"}
            </button>
          </form>
        </details>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {tapId !== undefined && busy && !results ? (
        <p className="nfc-help" role="status">
          Looking up the card from that tap…
        </p>
      ) : null}
      {results && !scan.scan ? (
        <>
          {fromTap ? (
            <p className="nfc-help">Card from the selected tap:</p>
          ) : null}
          <AssignmentResults assignments={results} />
        </>
      ) : null}
    </section>
  );
}
