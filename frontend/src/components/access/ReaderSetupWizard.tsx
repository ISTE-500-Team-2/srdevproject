import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import type { AccessResource } from "../../lib/nfc";
import { LoadState } from "../Management";
import { Modal } from "../Modal";

type DetectedReader = {
  id: string;
  gatewayId: string;
  model: string;
  firmware: string | null;
  transport: "usb" | "network";
  connected: boolean;
};
type SetupJob = {
  id: string;
  readerId: string;
  deviceId: string;
  gatewayId: string;
  name: string;
  status: string;
  errorCode: string | null;
};
export type ReaderDiscovery = {
  configured: boolean;
  gateways: { id: string; name: string; online: boolean }[];
  devices: DetectedReader[];
  jobs: SetupJob[];
};
const active = (job: SetupJob) =>
  !["complete", "failed", "cancelled", "expired"].includes(job.status);
const labels: Record<string, string> = {
  queued: "Waiting for the Pi",
  backing_up: "Saving a recovery backup",
  connecting: "Connecting to Wi-Fi",
  pairing: "Pairing the reader",
  verifying: "Checking the reader and server",
  complete: "Reader connected",
  failed: "Setup needs attention",
  cancelled: "Setup cancelled",
  expired: "Setup timed out",
};
const failures: Record<string, string> = {
  disconnected:
    "The reader was unplugged. Reconnect it to the Pi and try again.",
  unsupported_firmware:
    "This reader needs compatible firmware before automatic setup is available.",
  backup_failed:
    "The recovery backup could not be verified. Nothing was provisioned.",
  wifi_failed:
    "The reader could not join Wi-Fi. Enter its network name and password and try again.",
  wifi_already_connected:
    "This reader already has a working Wi-Fi connection. Try again with “Use saved Wi-Fi” selected.",
  pairing_failed:
    "Secure pairing did not complete. Keep the reader connected and try again.",
  verification_failed:
    "The connection checks did not pass. The reader has not been enabled.",
  recovery_required:
    "The reader is disabled, but its saved settings could not be restored. Reconnect it by USB and ask the system administrator to use the recovery backup on the Pi.",
};

export function ReaderSetupWizard({
  open,
  onClose,
  onDone,
  onManual,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onManual: () => void;
}) {
  const discovery = useApi<ReaderDiscovery>(
    open ? "/admin/access/reader-setup" : null,
    { retainOnReload: true },
  );
  const resources = useApi<AccessResource[]>(
    open ? "/admin/access/resources" : null,
  );
  const [selected, setSelected] = useState<DetectedReader | null>(null),
    [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [reuseWifi, setReuseWifi] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setJobId(null);
      setError("");
      setReuseWifi(false);
    }
  }, [open]);
  // Refresh status without replacing or resetting the name/network form.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(discovery.reload, 2000);
    return () => window.clearInterval(timer);
  }, [open, discovery.reload]);
  const data = discovery.data,
    job = data?.jobs.find((j) => j.id === jobId);
  const pending = data?.jobs.filter(active) ?? [];
  const devices =
    data?.devices.filter(
      (d) =>
        d.connected &&
        !pending.some(
          (j) => j.deviceId === d.id && j.gatewayId === d.gatewayId,
        ),
    ) ?? [];
  async function begin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || submitting.current) return;
    const form = e.currentTarget,
      f = new FormData(form),
      [kind, id] = String(f.get("resource")).split(":");
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await api<{ id: string }>("/admin/access/reader-setup", {
        method: "POST",
        body: {
          gatewayId: selected.gatewayId,
          deviceId: selected.id,
          name: f.get("name"),
          kind,
          resourceId: Number(id),
          ssid: f.get("ssid") ?? "",
          password: f.get("password") ?? "",
          reuseWifi,
          reason: f.get("reason"),
        },
      });
      form.reset();
      setSelected(null);
      setJobId(created.id);
      discovery.reload();
    } catch (e) {
      setError(errorMessage(e));
      discovery.reload();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/access/reader-setup/${job.id}/cancel`, {
        method: "POST",
        body: {},
      });
      discovery.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title="Add reader"
      width="compact"
      dirty={!!selected}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="nfc-setup-wizard">
        <p className="nfc-help">
          {job
            ? "Step 3 of 3 · Connect"
            : selected
              ? "Step 2 of 3 · Name & location"
              : "Step 1 of 3 · Find your reader"}
        </p>
        <LoadState
          loading={discovery.loading}
          error={discovery.error}
          reload={discovery.reload}
        />
        {!jobId && !selected && data ? (
          <>
            <p>
              Plug your reader into the Orange Pi with a USB data cable.
              Connected readers appear here automatically.
            </p>
            {!data.configured ? (
              <p className="form-error" role="alert">
                Reader discovery is not installed on a Pi yet. Ask the system
                administrator to connect the Pi setup service.
              </p>
            ) : null}
            {data.configured && !data.gateways.some((g) => g.online) ? (
              <p className="form-notice" role="status">
                Waiting for the Pi. Check its power and network connection.
              </p>
            ) : null}
            <div className="nfc-card-list" aria-label="Detected readers">
              {devices.map((d) => (
                <article className="nfc-card" key={d.gatewayId + ":" + d.id}>
                  <div className="nfc-section__heading">
                    <h3>{d.model}</h3>
                    <span className="activity-badge is-allowed">Detected</span>
                  </div>
                  <p className="nfc-help">
                    {data.gateways.find((g) => g.id === d.gatewayId)?.name} ·{" "}
                    {d.transport === "usb"
                      ? "USB connected"
                      : "Found on network"}
                  </p>
                  {d.firmware ? (
                    <p className="nfc-help">Firmware {d.firmware}</p>
                  ) : null}
                  <button
                    className="button button--primary"
                    onClick={() => {
                      setSelected(d);
                      setError("");
                    }}
                  >
                    Set up {d.model}
                  </button>
                </article>
              ))}
            </div>
            {data.configured &&
            data.gateways.some((g) => g.online) &&
            !devices.length &&
            !pending.length ? (
              <p className="empty-state" role="status">
                Looking for connected readers… Keep the reader plugged into the
                Pi.
              </p>
            ) : null}
            {pending.map((j) => (
              <button
                key={j.id}
                className="button button--quiet"
                onClick={() => setJobId(j.id)}
              >
                Continue setup: {j.name}
              </button>
            ))}
            <div className="management-actions">
              <button
                className="button button--quiet"
                disabled={discovery.refreshing}
                onClick={discovery.reload}
              >
                Check again
              </button>
              <button className="nfc-dismiss" onClick={onManual}>
                Advanced manual setup
              </button>
            </div>
          </>
        ) : null}
        {selected && !jobId ? (
          <form className="management-form nfc-reader-form" onSubmit={begin}>
            <p className="nfc-help">
              {selected.model} ·{" "}
              {data?.gateways.find((g) => g.id === selected.gatewayId)?.name}
            </p>
            <fieldset disabled={busy}>
              <label>
                Reader name
                <input
                  name="name"
                  required
                  maxLength={100}
                  placeholder="For example, Front door"
                />
              </label>
              <LoadState {...resources} />
              <label>
                Reader location
                <select name="resource" required defaultValue="">
                  <option value="">Choose a location</option>
                  {resources.data?.map((r) => (
                    <option
                      key={r.kind + ":" + r.id}
                      value={r.kind + ":" + r.id}
                    >
                      {r.name} · {r.kind}
                    </option>
                  ))}
                </select>
              </label>
              <label className="nfc-checkbox">
                <input
                  type="checkbox"
                  checked={reuseWifi}
                  onChange={(e) => setReuseWifi(e.target.checked)}
                />
                Use saved Wi-Fi
              </label>
              {!reuseWifi ? (
                <>
                  <label>
                    Wi-Fi network
                    <input
                      name="ssid"
                      required
                      maxLength={32}
                      autoComplete="off"
                      placeholder="Network the reader will use"
                    />
                  </label>
                  <label>
                    Wi-Fi password
                    <input
                      name="password"
                      type="password"
                      maxLength={63}
                      autoComplete="new-password"
                    />
                    <small className="nfc-help">
                      Leave blank for an open network. Keep USB connected during
                      setup.
                    </small>
                  </label>
                </>
              ) : (
                <p className="nfc-help">
                  Choose this only if the reader already connects to Wi-Fi. Its
                  saved network will be kept.
                </p>
              )}
              <label>
                Reason for change
                <input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="For example, Installing a new reader"
                />
              </label>
              {selected.transport === "network" ? (
                <p className="form-error">
                  Connect this reader to the Pi by USB to securely complete
                  setup.
                </p>
              ) : null}
              <div className="management-actions">
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => {
                    setSelected(null);
                    setError("");
                  }}
                >
                  Back
                </button>
                <button
                  className="button button--primary"
                  disabled={selected.transport !== "usb"}
                >
                  {busy ? "Starting setup…" : "Connect reader"}
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}
        {jobId ? (
          <section aria-label="Reader setup progress" aria-live="polite">
            <h3>
              {job
                ? (labels[job.status] ?? "Checking setup")
                : "Checking setup…"}
            </h3>
            {job ? (
              <>
                <p>{job.name}</p>
                {!["failed", "cancelled", "expired"].includes(job.status) ? (
                  <ul
                    className="nfc-setup-checks"
                    aria-label="Connection checks"
                  >
                    {[
                      "Wi-Fi connection",
                      "Secure pairing",
                      "NFC reader & server",
                    ].map((label, i) => {
                      const phase = [
                        "queued",
                        "backing_up",
                        "connecting",
                        "pairing",
                        "verifying",
                        "complete",
                      ].indexOf(job.status);
                      const finished =
                        job.status === "complete" || phase > [2, 3, 4][i]!;
                      const checking = !finished && phase === [2, 3, 4][i];
                      return (
                        <li key={label}>
                          <span>{label}</span>
                          <span
                            className={`activity-badge is-${finished ? "allowed" : "neutral"}`}
                          >
                            {finished
                              ? "Complete"
                              : checking
                                ? "Checking…"
                                : "Waiting"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {active(job) ? (
                  <>
                    <p>
                      Keep the reader connected. The Pi is preparing and
                      checking its connection.
                    </p>
                    <p className="nfc-help">
                      You can close this dialog and return to check progress.
                    </p>
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={cancel}
                    >
                      Cancel setup
                    </button>
                  </>
                ) : null}
                {job.status === "complete" ? (
                  <>
                    <p>
                      The reader is paired, its NFC module is ready, and the
                      server has received its authenticated heartbeat.
                    </p>
                    <p className="nfc-help">
                      Next, tap a card to test access. Existing card and
                      membership rules still apply.
                    </p>
                    <button
                      className="button button--primary"
                      onClick={() => {
                        onDone();
                        onClose();
                      }}
                    >
                      Done
                    </button>
                  </>
                ) : null}
                {["failed", "cancelled", "expired"].includes(job.status) ? (
                  <>
                    <p className="form-error" role="alert">
                      {failures[job.errorCode ?? ""] ??
                        "Setup did not finish. The reader has not been enabled."}
                    </p>
                    <button
                      className="button button--primary"
                      onClick={() => {
                        setJobId(null);
                        setError("");
                        discovery.reload();
                      }}
                    >
                      Try again
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
