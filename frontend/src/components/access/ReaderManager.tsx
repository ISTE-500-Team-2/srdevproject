import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import {
  facilityTime,
  type AccessReader,
  type AccessResource,
  type ReaderSetup,
} from "../../lib/nfc";
import { LoadState } from "../Management";
import { Modal } from "../Modal";
import {ReaderSetupWizard} from './ReaderSetupWizard';

export function ReaderManager({
  setup,
  reload,
  refreshing = false,
}: {
  setup: ReaderSetup;
  reload: () => void;
  refreshing?: boolean;
}) {
  const resources = useApi<AccessResource[]>("/admin/access/resources");
  const [adding,setAdding]=useState(false);
  const [editing, setEditing] = useState<AccessReader | "new" | null>(null),
    [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (editing === "new") {
        const [kind, id] = String(f.get("resource")).split(":");
        const created = await api<{ id: string; secret: string }>(
          "/admin/access/readers",
          {
            method: "POST",
            body: {
              id: f.get("id"),
              name: f.get("name"),
              kind,
              resourceId: Number(id),
              reason: f.get("reason"),
            },
          },
        );
        setSecret(created);
        setNotice(
          "Reader added. Install its credentials on the reader to connect it.",
        );
      } else {
        await api(`/admin/access/readers/${editing.id}`, {
          method: "PATCH",
          body: {
            name: f.get("name"),
            enabled: f.get("enabled") === "on",
            expectedRevision: editing.revision,
            reason: f.get("reason"),
          },
        });
        setNotice("Reader settings saved.");
      }
      setEditing(null);
      reload();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) setEditing(null);
      reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nfc-section" aria-label="Readers">
      <div className="nfc-section__heading">
        <h2>Readers</h2>
        <div className="management-actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={reload}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing readers…" : "Refresh readers"}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!setup.configured}
            onClick={() => {
              setAdding(true);
              setError("");
              setNotice("");
            }}
          >
            Add reader
          </button>
        </div>
      </div>
      <p className="nfc-help">
        Online means an authenticated tap or heartbeat arrived in the last 45
        seconds. Idle readers should send a heartbeat every 15 seconds.
      </p>
      {!setup.configured ? (
        <p className="form-error" role="alert">
          NFC setup is incomplete. Ask the system administrator to configure the
          card security key before adding readers.
        </p>
      ) : null}
      {!editing && error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="form-notice" role="status">
          {notice}{" "}
          <button className="nfc-dismiss" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </p>
      ) : null}
      {secret ? (
        <section
          className="nfc-credentials"
          aria-label="New reader credentials"
        >
          <h3>Connect {secret.id}</h3>
          <p>
            Save this secret in the reader’s secure configuration. It is shown
            only here.
          </p>
          <label>
            Reader secret
            <input
              value={secret.secret}
              readOnly
              autoComplete="off"
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="button button--quiet"
            onClick={() => setSecret(null)}
          >
            I have saved the secret
          </button>
        </section>
      ) : null}
      {!setup.readers.length ? (
        <p className="empty-state">
          No readers yet. Connect a reader to the Pi, then choose Add reader.
        </p>
      ) : null}
      <div className="nfc-card-list">
        {setup.readers.map((r) => (
          <article className="nfc-card" key={r.id}>
            <div className="nfc-section__heading">
              <h3>{r.name}</h3>
              <span
                className={`activity-badge is-${!r.enabled ? "neutral" : r.online ? "allowed" : "denied"}`}
              >
                {!r.enabled ? "Disabled" : r.online ? "Online" : "Offline"}
              </span>
            </div>
            <p>
              {r.resourceName} · {r.kind}
            </p>
            <p className="nfc-help">Reader ID: {r.id}</p>
            <p className="nfc-help">
              {r.lastSeenAt
                ? `Last seen ${facilityTime(r.lastSeenAt, setup.timeZone)}`
                : "No connection recorded yet."}
            </p>
            <button
              className="button button--quiet"
              onClick={() => {
                setEditing(r);
                setError("");
                setNotice("");
              }}
            >
              Manage {r.name}
            </button>
          </article>
        ))}
      </div>
      <ReaderSetupWizard open={adding} onClose={()=>setAdding(false)} onDone={reload}
        onManual={()=>{setAdding(false);setEditing('new');setError('');setNotice('');}}/>
      <Modal
        open={!!editing}
        title={
          editing === "new"
            ? "Add reader"
            : `Manage ${editing?.name ?? "reader"}`
        }
        onClose={() => {
          if (!busy) setEditing(null);
        }}
        width="compact"
      >
        {editing ? (
          <form className="management-form nfc-reader-form" onSubmit={save}>
            <fieldset disabled={busy}>
              <label>
                Reader name
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={editing === "new" ? "" : editing.name}
                  placeholder="For example, Front door"
                />
              </label>
              {editing === "new" ? (
                <>
                  <label>
                    Reader ID
                    <input
                      name="id"
                      required
                      pattern="[a-zA-Z0-9_-]{1,64}"
                      maxLength={64}
                      autoComplete="off"
                    />
                    <small className="nfc-help">
                      A unique ID for the reader configuration, such as
                      front-door.
                    </small>
                  </label>
                  <LoadState {...resources} />
                  <label>
                    Reader location
                    <select name="resource" required defaultValue="">
                      <option value="">Choose a location</option>
                      {resources.data?.map((r) => (
                        <option
                          key={`${r.kind}:${r.id}`}
                          value={`${r.kind}:${r.id}`}
                        >
                          {r.name} · {r.kind}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <label className="nfc-checkbox">
                  <input
                    name="enabled"
                    type="checkbox"
                    defaultChecked={editing.enabled}
                  />
                  Reader enabled
                </label>
              )}
              <label>
                Reason for change
                <input name="reason" required maxLength={500} />
              </label>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button className="button button--primary">
                {busy
                  ? "Saving reader…"
                  : editing === "new"
                    ? "Create reader"
                    : "Save reader"}
              </button>
            </fieldset>
          </form>
        ) : null}
      </Modal>
    </section>
  );
}
