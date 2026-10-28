import { AlertTriangle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../Modal";
import { MemberSelect } from "../MemberSelect";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { localInput } from "../../lib/display";
import type { Course, Room, ScheduleSeed } from "./classData";

const tomorrow = () => localInput(new Date(Date.now() + 86400000)).slice(0, 10);
const roomConflict = new Set(["RESERVATION_CONFLICT", "RESERVATION_COOLDOWN"]);

function duration(date: string, start: string, end: string) {
  if (!date || !start || !end) return null;
  const minutes = (new Date(`${date}T${end}`).getTime() - new Date(`${date}T${start}`).getTime()) / 60000;
  return Number.isFinite(minutes) ? minutes : null;
}
function durationText(minutes: number) {
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return [h ? `${h} ${h === 1 ? "hour" : "hours"}` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

export function ScheduleClassDialog({
  seed,
  onDirty,
  onClose,
  onPublished,
}: {
  seed: ScheduleSeed;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onPublished: (title: string) => void;
}) {
  const catalog = useApi<Course[]>("/training/catalog");
  const rooms = useApi<Room[]>("/rooms");
  const [form, setForm] = useState({
    title: seed.title ?? "",
    certificationId: seed.certificationId ? String(seed.certificationId) : "",
    instructorId: seed.instructorId ? String(seed.instructorId) : "",
    roomId: seed.roomId ? String(seed.roomId) : "",
    capacity: seed.capacity ? String(seed.capacity) : "",
    date: tomorrow(),
    start: seed.start ?? "18:00",
    end: seed.end ?? "20:00",
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const room = rooms.data?.find((r) => String(r.id) === form.roomId);
  const minutes = duration(form.date, form.start, form.end);
  const timeProblem =
    minutes === null
      ? ""
      : minutes <= 0
        ? "End time must be after the start time."
        : minutes > 480
          ? "Classes can run up to 8 hours."
          : new Date(`${form.date}T${form.start}`).getTime() <= Date.now()
            ? "Pick a start time in the future."
            : "";

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "roomId") {
        // Seats default to the room's size and can't exceed it.
        const cap = rooms.data?.find((r) => String(r.id) === value)?.capacity;
        if (cap && (!current.capacity || Number(current.capacity) > cap)) next.capacity = String(cap);
      }
      return next;
    });
    if (key === "roomId" || key === "date" || key === "start" || key === "end") setRoomError("");
    onDirty(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (timeProblem) return;
    setBusy(true);
    setError("");
    setRoomError("");
    try {
      await api("/classes", {
        method: "POST",
        body: {
          title: form.title.trim(),
          certificationId: Number(form.certificationId),
          instructorId: Number(form.instructorId),
          roomId: Number(form.roomId),
          capacity: Number(form.capacity),
          startsAt: new Date(`${form.date}T${form.start}`).toISOString(),
          endsAt: new Date(`${form.date}T${form.end}`).toISOString(),
          reason: form.reason.trim(),
        },
      });
      onDirty(false);
      onPublished(form.title.trim());
    } catch (e) {
      if (e instanceof ApiError && roomConflict.has(e.code)) {
        setRoomError("Booked for part of this time");
        setError(
          `${room?.name ?? "That room"} is already booked for part of this time. Pick another room or time. Bookings in the same room need 15 minutes between them.`,
        );
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const courses = catalog.data?.filter((c) => c.validityDays) ?? [];
  const available = rooms.data?.filter((r) => r.status === "available") ?? [];
  return (
    <Modal open title="Schedule a class" onClose={onClose}>
      <form className="class-form" onSubmit={(e) => void submit(e)}>
        {error ? (
          <p className="class-banner class-banner--error" role="alert">
            <AlertTriangle aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        {catalog.error || rooms.error ? (
          <p className="form-error" role="alert">
            {catalog.error || rooms.error}{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                catalog.reload();
                rooms.reload();
              }}
            >
              Retry
            </button>
          </p>
        ) : null}
        <fieldset disabled={busy}>
          <legend>
            <i>1</i>Class
          </legend>
          <label className="class-field">
            <span>Title</span>
            <input value={form.title} required maxLength={100} onChange={(e) => set("title", e.target.value)} />
          </label>
          <label className="class-field">
            <span>Counts toward</span>
            <select value={form.certificationId} required onChange={(e) => set("certificationId", e.target.value)}>
              <option value="">Choose certification</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <small>
              Only certifications with a validity period are listed. Set that up in <Link to="/training">Training</Link>.
            </small>
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            <i>2</i>When &amp; where
          </legend>
          <div className="class-form__times">
            <label className="class-field">
              <span>Date</span>
              <input type="date" value={form.date} required min={localInput().slice(0, 10)} onChange={(e) => set("date", e.target.value)} />
            </label>
            <label className="class-field">
              <span>Starts</span>
              <input type="time" value={form.start} required step={900} onChange={(e) => set("start", e.target.value)} />
            </label>
            <label className="class-field">
              <span>Ends</span>
              <input type="time" value={form.end} required step={900} onChange={(e) => set("end", e.target.value)} />
            </label>
          </div>
          <small className={timeProblem ? "class-field__error" : "class-form__hint"}>
            {timeProblem || (minutes ? `${durationText(minutes)} · classes can run up to 8 hours` : "")}
          </small>
          <div className="class-form__pair">
            <label className="class-field">
              <span>Room</span>
              <select
                value={form.roomId}
                required
                aria-invalid={Boolean(roomError)}
                onChange={(e) => set("roomId", e.target.value)}
              >
                <option value="">Choose room</option>
                {available.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.location}
                  </option>
                ))}
              </select>
              {roomError ? (
                <small className="class-field__error">
                  <AlertTriangle aria-hidden="true" />
                  {roomError}
                </small>
              ) : null}
            </label>
            <label className="class-field">
              <span>Seats</span>
              <input
                type="number"
                min={1}
                max={room?.capacity ?? 500}
                required
                value={form.capacity}
                onChange={(e) => set("capacity", e.target.value)}
              />
              {room?.capacity ? <small>Can't exceed the room's {room.capacity} seats</small> : null}
            </label>
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            <i>3</i>Instructor &amp; record
          </legend>
          <div className="class-field class-field--picker">
            <MemberSelect
              name="instructorId"
              label="Instructor"
              instructorsOnly
              value={form.instructorId}
              onChange={(value) => set("instructorId", value)}
            />
          </div>
          <label className="class-field">
            <span>
              Reason <em>· saved to the change log</em>
            </span>
            <input value={form.reason} required maxLength={500} onChange={(e) => set("reason", e.target.value)} />
          </label>
        </fieldset>
        <div className="class-dialog-actions">
          <span />
          <button type="button" className="button button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={busy || Boolean(timeProblem) || catalog.loading || rooms.loading || Boolean(catalog.error || rooms.error)}
          >
            {busy ? "Publishing…" : "Publish class"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
