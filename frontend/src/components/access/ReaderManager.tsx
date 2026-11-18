// Staff editor for reader names, resource targets and enabled state, using server revisions to
// detect stale changes.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, errorMessage } from "../../lib/api";
import { editingFormRef } from "../../lib/editingForms";
import { useApi } from "../../lib/useApi";
import {
  facilityTime,
  type AccessReader,
  type AccessResource,
  type ReaderHealthBoard as HealthBoard,
  type ReaderSetup,
} from "../../lib/nfc";
import { LoadState } from "../Management";
import { Modal } from "../Modal";
import {ReaderSetupWizard,type ReaderDiscovery} from './ReaderSetupWizard';
import { ReaderHealthBoard, readerLink } from "./ReaderHealthBoard";
import { ReaderDetail } from "./ReaderDetail";

export function ReaderManager({
  setup,
  reload,
}: {
  setup: ReaderSetup;
  reload: () => void;
}) {
  const [params] = useSearchParams();
  const selected = params.get("reader");
  const resources = useApi<AccessResource[]>("/admin/access/resources");
  // Live: the board refreshes itself, so there is no manual refresh control.
  const health = useApi<HealthBoard>(setup.configured && !selected ? "/admin/access/reader-health" : null, {
    retainOnReload: true,
    refreshInterval: 5000,
  });
  // A reader added or changed elsewhere (setup wizard, another staff member)
  // shows up on the board first; reload the reader list once per difference.
  const synced = useRef("");
  useEffect(() => {
    if (!health.data) return;
    const board = new Set(health.data.readers.map((reader) => reader.id));
    const listed = new Set(setup.readers.map((reader) => reader.id));
    const difference = [...board].filter((id) => !listed.has(id))
      .concat([...listed].filter((id) => !board.has(id)))
      .sort()
      .join(",");
    if (difference && difference !== synced.current) reload();
    synced.current = difference;
  }, [health.data, setup.readers, reload]);
  const [adding,setAdding]=useState(false);
  const discovery=useApi<ReaderDiscovery>(setup.configured?'/admin/access/reader-setup':null,{retainOnReload:true,refreshInterval:5000});
  const detected=discovery.data?.devices.filter(d=>d.connected&&!d.readerName&&!discovery.data?.jobs.some(j=>j.gatewayId===d.gatewayId&&j.deviceId===d.id&&!['failed','cancelled','expired'].includes(j.status))).length??0;
  // A reader joins the list only once its guided setup completes, which can happen after the
  // wizard is closed: reload the readers whenever another setup job finishes.
  const completed=discovery.data?.jobs.filter(j=>j.status==='complete').map(j=>j.id).join(',');
  const seenCompleted=useRef(completed);
  useEffect(()=>{
    if(completed===undefined) return;
    if(seenCompleted.current!==undefined&&seenCompleted.current!==completed) reload();
    seenCompleted.current=completed;
  },[completed,reload]);
  const [editing, setEditing] = useState<AccessReader | "new" | null>(null),
    [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const location =
    editing && editing !== "new" ? `${editing.kind}:${editing.resourceId}` : "";
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
        // Send a location only when it changed, so renaming or disabling a reader whose
        // location was removed still works.
        const resource = String(f.get("resource")),
          [kind, id] = resource.split(":");
        await api(`/admin/access/readers/${editing.id}`, {
          method: "PATCH",
          body: {
            name: f.get("name"),
            enabled: f.get("enabled") === "on",
            ...(resource !== location ? { kind, resourceId: Number(id) } : {}),
            expectedRevision: editing.revision,
            reason: f.get("reason"),
          },
        });
        setNotice("Reader settings saved.");
      }
      setEditing(null);
      reload();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setError(
        editing === "new" && code === "ALREADY_EXISTS"
          ? `A reader with the ID “${String(f.get("id"))}” already exists. Choose a different reader ID.`
          : errorMessage(e),
      );
      // Only a stale edit closes the form, to reopen on the latest settings. Any other
      // failure keeps what was typed for another try.
      if (code === "STALE_RECORD") setEditing(null);
      reload();
    } finally {
      setBusy(false);
    }
  }
  const manage = (reader: AccessReader) => {
    setEditing(reader);
    setError("");
    setNotice("");
  };
  const dialogs = (
    <>
      <ReaderSetupWizard open={adding} onClose={()=>{setAdding(false);reload();}} onDone={reload}
        onManual={()=>{setAdding(false);setEditing('new');setError('');setNotice('');}}/>
      <Modal
        open={!!editing}
        title={
          editing === "new"
            ? "Add reader"
            : "Manage reader"
        }
        onClose={() => {
          if (!busy) setEditing(null);
        }}
        width="compact"
      >
        {editing ? (
          <ReaderForm editing={editing} location={location} busy={busy} error={error} resources={resources} onSubmit={save} />
        ) : null}
      </Modal>
    </>
  );
  if (selected)
    return (
      <section className="nfc-section" aria-label="Reader">
        {notice ? (
          <p className="form-notice" role="status">
            {notice}{" "}
            <button className="nfc-dismiss" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </p>
        ) : null}
        <ReaderDetail
          id={selected}
          reader={setup.readers.find((reader) => reader.id === selected)}
          timeZone={setup.timeZone}
          onManage={manage}
        />
        {dialogs}
      </section>
    );
  return (
    <section className="nfc-section" aria-label="Readers">
      <div className="nfc-section__heading">
        <h2>Readers</h2>
        <div className="management-actions">
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
      {detected?<p className="form-notice" role="status">{detected===1?'A new reader is connected':'New readers are connected'}. Choose Add reader to finish setup.</p>:null}
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
      {health.data ? (
        <ReaderHealthBoard
          board={health.data}
          readers={setup.readers}
          timeZone={setup.timeZone}
          stale={!!health.error}
        />
      ) : (
        <>
          <LoadState {...health} />
          {(!setup.configured || health.error) && setup.readers.length ? (
            <ReaderList readers={setup.readers} onManage={manage} />
          ) : null}
        </>
      )}
      {dialogs}
    </section>
  );
}

/** Plain reader list for when live health is unavailable, so Manage stays reachable. */
function ReaderList({ readers, onManage }: { readers: AccessReader[]; onManage: (reader: AccessReader) => void }) {
  return (
    <ul className="nfc-card-list" aria-label="Readers">
      {readers.map((reader) => (
        <li className="nfc-card" key={reader.id}>
          <div className="nfc-section__heading">
            <h3>
              <Link to={readerLink(reader.id)}>{reader.name}</Link>
            </h3>
            <span className={`activity-badge is-${reader.enabled ? "allowed" : "neutral"}`}>
              {reader.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p>{reader.resourceName}</p>
          <button type="button" className="button button--quiet" onClick={() => onManage(reader)}>
            Manage {reader.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The add/manage form; shared by the reader list and the reader page. */
function ReaderForm({
  editing,
  location,
  busy,
  error,
  resources,
  onSubmit,
}: {
  editing: AccessReader | "new";
  location: string;
  busy: boolean;
  error: string;
  resources: ReturnType<typeof useApi<AccessResource[]>>;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form ref={editingFormRef} className="management-form nfc-reader-form" onSubmit={onSubmit}>
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
        ) : null}
        <LoadState {...resources} />
        <label>
          Reader location
          <select name="resource" required defaultValue={location}>
            {editing === "new" ? (
              <option value="">Choose a location</option>
            ) : (
              <option value={location}>
                {editing.resourceName} · {editing.kind}
              </option>
            )}
            {resources.data
              ?.filter((r) => `${r.kind}:${r.id}` !== location)
              .map((r) => (
                <option
                  key={`${r.kind}:${r.id}`}
                  value={`${r.kind}:${r.id}`}
                >
                  {r.name} · {r.kind}
                </option>
              ))}
          </select>
        </label>
        {editing === "new" ? null : (
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
  );
}
