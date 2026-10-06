import { CalendarDays, Pencil, Plus, RefreshCw, XCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Toast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import type { LiveEquipment, Reservation } from "../lib/contracts";
import type { Page } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

type ReservationForm = {
  userId: string;
  equipmentId: string;
  startTime: string;
  duration: string;
};

const emptyForm: ReservationForm = {
  userId: "",
  equipmentId: "",
  startTime: "",
  duration: "1",
};

export function StaffReservations() {
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({
    date: "",
    userId: "",
    equipmentId: "",
  });
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [form, setForm] = useState<ReservationForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const query = new URLSearchParams();
  query.set("offset", String(offset));
  if (filters.date) query.set("date", filters.date);
  if (filters.userId) query.set("userId", filters.userId);
  if (filters.equipmentId) query.set("equipmentId", filters.equipmentId);
  const reservations = useApi<Page<Reservation>>(
    `/admin/reservations?${query.toString()}`,
  );
  const equipment = useApi<LiveEquipment[]>("/equipment");

  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setFilters({
      date: String(data.get("date") ?? ""),
      userId: String(data.get("userId") ?? "").trim(),
      equipmentId: String(data.get("equipmentId") ?? "").trim(),
    });
    setOffset(0);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const start = new Date(form.startTime);
      const end = new Date(
        start.getTime() + Number(form.duration) * 60 * 60 * 1000,
      );
      const body = {
        userId: Number(form.userId),
        equipmentId: Number(form.equipmentId),
        roomId: null,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        ...(editing ? { expectedRevision: editing.revision } : {}),
      };
      if (editing) {
        await api<Reservation>(`/admin/reservations/${editing.id}`, {
          method: "PATCH",
          body,
        });
        setToast("Reservation updated.");
      } else {
        await api<Reservation>("/reservations", { method: "POST", body });
        setToast("Reservation created.");
      }
      setEditing(null);
      setForm(emptyForm);
      reservations.reload();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (reservation: Reservation) => {
    setBusy(true);
    setMessage("");
    try {
      await api(`/admin/reservations/${reservation.id}/cancel`, {
        method: "POST",
      });
      setToast("Reservation cancelled.");
      reservations.reload();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setMessage("");
  };

  const startEdit = (reservation: Reservation) => {
    setEditing(reservation);
    setMessage("");
    setForm({
      userId: String(reservation.userId),
      equipmentId: String(reservation.equipmentId ?? ""),
      startTime: toLocalInput(reservation.startTime),
      duration: String(
        Math.max(
          1,
          Math.round(
            (new Date(reservation.endTime).getTime() -
              new Date(reservation.startTime).getTime()) /
              3_600_000,
          ),
        ),
      ),
    });
  };

  return (
    <section className="management-grid">
      <div>
        <h2>Reservation management</h2>
        <p>
          Create and manage equipment reservations for any member. Staff
          overrides are recorded in the change log.
        </p>
        <form className="management-search" onSubmit={submitFilters}>
          <label>
            Date
            <input name="date" type="date" defaultValue={filters.date} />
          </label>
          <label>
            Member ID
            <input
              name="userId"
              type="number"
              min="1"
              defaultValue={filters.userId}
            />
          </label>
          <label>
            Equipment ID
            <input
              name="equipmentId"
              type="number"
              min="1"
              defaultValue={filters.equipmentId}
            />
          </label>
          <button className="button button--quiet">Filter</button>
          <button
            className="button button--quiet"
            type="button"
            onClick={reservations.reload}
          >
            <RefreshCw aria-hidden="true" /> Refresh
          </button>
        </form>
        {reservations.loading ? <p role="status">Loading reservations...</p> : null}
        {reservations.error ? (
          <p className="form-error" role="alert">
            {reservations.error}
          </p>
        ) : null}
        {message ? (
          <p className="form-error" role="alert">
            {message}
          </p>
        ) : null}
        <div className="management-records">
          {reservations.data?.items.map((item) => (
            <article className="management-record" key={item.id}>
              <div>
                <h3>
                  {item.equipmentName} <small>#{item.id}</small>
                </h3>
                <span className="status-label">{item.status}</span>
              </div>
              <p>
                {new Date(item.startTime).toLocaleString()} to{" "}
                {new Date(item.endTime).toLocaleString()}
              </p>
              <p>
                Member #{item.userId}
                {item.memberName ? `, ${item.memberName}` : ""} ·{" "}
                {item.location}
              </p>
              <div className="management-actions">
                <button
                  className="button button--quiet"
                  disabled={busy || item.resourceType !== "equipment"}
                  onClick={() => startEdit(item)}
                >
                  <Pencil aria-hidden="true" /> Modify
                </button>
                {["confirmed", "pending"].includes(item.status) ? (
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => void cancel(item)}
                  >
                    <XCircle aria-hidden="true" /> Cancel
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        {!reservations.loading && !reservations.data?.items.length ? (
          <p className="empty-state">No reservations match these filters.</p>
        ) : null}
        <div className="management-actions">
          <button
            className="button button--quiet"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <button
            className="button button--quiet"
            disabled={reservations.data?.nextOffset == null}
            onClick={() => setOffset(reservations.data?.nextOffset ?? offset)}
          >
            Next
          </button>
        </div>
      </div>
      <aside className="management-panel panel">
        <h2>{editing ? "Modify reservation" : "Create reservation"}</h2>
        <form className="management-form" onSubmit={save}>
          <label className="form-field">
            Member ID
            <input
              required
              type="number"
              min="1"
              value={form.userId}
              onChange={(event) =>
                setForm({ ...form, userId: event.target.value })
              }
            />
          </label>
          <label className="form-field">
            Equipment
            <select
              required
              value={form.equipmentId}
              onChange={(event) =>
                setForm({ ...form, equipmentId: event.target.value })
              }
            >
              <option value="">Select equipment</option>
              {equipment.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.id} {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            Start date and time
            <input
              required
              type="datetime-local"
              value={form.startTime}
              onChange={(event) =>
                setForm({ ...form, startTime: event.target.value })
              }
            />
          </label>
          <label className="form-field">
            Duration
            <select
              value={form.duration}
              onChange={(event) =>
                setForm({ ...form, duration: event.target.value })
              }
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} {i === 0 ? "hour" : "hours"}
                </option>
              ))}
            </select>
          </label>
          <div className="management-actions">
            <button className="button button--primary" disabled={busy}>
              {editing ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {busy ? "Saving..." : editing ? "Save changes" : "Create"}
            </button>
            {editing ? (
              <button
                className="button button--quiet"
                type="button"
                onClick={startCreate}
              >
                <CalendarDays aria-hidden="true" /> New reservation
              </button>
            ) : null}
          </div>
        </form>
      </aside>
      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}

function toLocalInput(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
