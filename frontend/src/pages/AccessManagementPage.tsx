import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState, dateTime } from "../components/Management";
type Card = {
  id: number;
  label: string;
  active: boolean;
  revision: number;
  assignedAt: string;
};
export function AccessManagementPage() {
  const [member, setMember] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const cards = useApi<Card[]>(
    member ? "/admin/access/cards?userId=" + member : null,
  );
  const overrides = useApi<
    {
      id: number;
      kind: string;
      resourceId: number;
      endsAt: string;
      reason: string;
      revokedAt: string | null;
    }[]
  >(member ? "/admin/access/overrides?userId=" + member : null);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      cards.reload();
      overrides.reload();
      setMessage("Access record saved.");
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    await run(async () => {
      await api("/admin/access/cards", {
        method: "POST",
        body: {
          userId: Number(member),
          uid: f.get("uid"),
          label: f.get("label"),
          reason: f.get("reason"),
        },
      });
      form.reset();
    });
  }
  return (
    <section className="management-page">
      <h1>Reader access management</h1>
      <p>
        Cards link to a member; every scan rechecks current safety and access
        rules. Raw card identifiers are not shown in saved records.
      </p>
      {message ? <p role="status">{message}</p> : null}
      <form
        className="management-search"
        onSubmit={(e) => {
          e.preventDefault();
          setMember(String(new FormData(e.currentTarget).get("member")));
        }}
      >
        <label>
          Member ID
          <input name="member" type="number" min={1} required />
        </label>
        <button className="button button--quiet">Load cards</button>
      </form>
      {member ? (
        <>
          <LoadState {...cards} />
          {cards.data?.map((c) => (
            <article className="saved-record" key={c.id}>
              <h2>{c.label}</h2>
              <p>
                {c.active ? "Active" : "Revoked"} · assigned{" "}
                {dateTime(c.assignedAt)}
              </p>
              {c.active ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void run(() =>
                      api(`/admin/access/cards/${c.id}/revoke`, {
                        method: "POST",
                        body: {
                          expectedRevision: c.revision,
                          reason: f.get("reason"),
                        },
                      }),
                    );
                  }}
                >
                  <label>
                    Revocation reason
                    <input name="reason" required maxLength={500} />
                  </label>
                  <button className="button button--quiet" disabled={busy}>
                    Revoke {c.label}
                  </button>
                </form>
              ) : null}
            </article>
          ))}
          <form className="management-form" onSubmit={assign}>
            <h2>Assign scanned card</h2>
            <label>
              Card UID
              <input name="uid" autoComplete="off" required />
            </label>
            <label>
              Card label
              <input name="label" maxLength={100} required />
            </label>
            <label>
              Assignment reason
              <input name="reason" maxLength={500} required />
            </label>
            <button className="button" disabled={busy}>
              Assign card
            </button>
          </form>
          <h2>Timed access overrides</h2>
          <LoadState {...overrides} />
          {overrides.data?.map((o) => (
            <article className="saved-record" key={o.id}>
              <h3>
                {o.kind} {o.resourceId}
              </h3>
              <p>
                {o.reason} · ends {dateTime(o.endsAt)} ·{" "}
                {o.revokedAt
                  ? "Revoked"
                  : new Date(o.endsAt) <= new Date()
                    ? "Expired"
                    : "Active"}
              </p>
              {!o.revokedAt && new Date(o.endsAt) > new Date() ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const reason = new FormData(e.currentTarget).get("reason");
                    void run(() =>
                      api(`/admin/access/overrides/${o.id}/revoke`, {
                        method: "POST",
                        body: { reason },
                      }),
                    );
                  }}
                >
                  <label>
                    Revocation reason
                    <input name="reason" required maxLength={500} />
                  </label>
                  <button className="button button--quiet" disabled={busy}>
                    Revoke override {o.id}
                  </button>
                </form>
              ) : null}
            </article>
          ))}
          <form
            className="management-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(() =>
                api("/admin/access/overrides", {
                  method: "POST",
                  body: {
                    userId: Number(member),
                    kind: f.get("kind"),
                    resourceId: Number(f.get("id")),
                    endsAt: new Date(String(f.get("endsAt"))).toISOString(),
                    reason: f.get("reason"),
                  },
                }),
              );
            }}
          >
            <h2>Short staff access override</h2>
            <p>
              Overrides only the reservation requirement, for at most 30
              minutes. Membership, waivers, training, and account restrictions
              still apply.
            </p>
            <label>
              Resource
              <select name="kind">
                <option value="equipment">Equipment</option>
                <option value="room">Room</option>
              </select>
            </label>
            <label>
              Resource ID
              <input name="id" type="number" min={1} required />
            </label>
            <label>
              Ends
              <input name="endsAt" type="datetime-local" required />
            </label>
            <label>
              Reason
              <input name="reason" required maxLength={500} />
            </label>
            <button className="button" disabled={busy}>
              Create timed override
            </button>
          </form>
        </>
      ) : null}
    </section>
  );
}
