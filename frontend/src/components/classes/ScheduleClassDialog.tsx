import { AlertTriangle, Info } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../Modal";
import { MemberSelect } from "../MemberSelect";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { cents, localInput } from "../../lib/display";
import type { Course, Room, ScheduleSeed, WorkshopTemplate } from "./classData";

const tomorrow = () => localInput(new Date(Date.now() + 86400000)).slice(0, 10);
const roomConflict = new Set(["RESERVATION_CONFLICT", "RESERVATION_COOLDOWN"]);
/** The sponsor caps every class at 15 people, whatever the room holds. */
const MAX_SEATS = 15;
const DESCRIPTION_MAX = 4000;
type Kind = "training" | "workshop";

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
  const workshops = useApi<WorkshopTemplate[]>("/classes/catalog");
  const [kind, setKind] = useState<Kind>(seed.catalogId ? "workshop" : "training");
  const [form, setForm] = useState({
    catalogId: seed.catalogId ? String(seed.catalogId) : "",
    title: seed.title ?? "",
    description: seed.description ?? "",
    certificationId: seed.certificationId ? String(seed.certificationId) : "",
    instructorId: seed.instructorId ? String(seed.instructorId) : "",
    roomId: seed.roomId ? String(seed.roomId) : "",
    capacity: seed.capacity ? String(Math.min(seed.capacity, 15)) : "",
    date: tomorrow(),
    start: seed.start ?? "18:00",
    end: seed.end ?? "20:00",
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const room = rooms.data?.find((r) => String(r.id) === form.roomId);
  const course = catalog.data?.find(c => String(c.id) === form.certificationId);
  const minutes = duration(form.date, form.start, form.end);
  const timeProblem =
    minutes === null
      ? ""
      : minutes <= 0
        ? "End time must be after the start time."
        : course?.trainingMinutes && minutes < course.trainingMinutes
          ? `This certification requires at least ${course.trainingMinutes} minutes of training.`
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
        if (cap && (!current.capacity || Number(current.capacity) > cap)) next.capacity = String(Math.min(cap, MAX_SEATS));
      }
      if (key === "catalogId") {
        // Picking a workshop fills in its title and description.
        const template = workshops.data?.find((w) => String(w.id) === value);
        if (template) {
          next.title = template.title;
          next.description = template.description;
          if (!current.capacity) next.capacity = String(Math.min(template.capacity, MAX_SEATS));
        }
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
          certificationId: kind === "training" ? Number(form.certificationId) : null,
          catalogId: kind === "workshop" ? Number(form.catalogId) : null,
          description: form.description,
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

  const courses = catalog.data ?? [];
  const available = rooms.data?.filter((r) => r.status === "available") ?? [];
  // Only the list the chosen class type needs can block publishing.
  const options = kind === "training" ? catalog : workshops;
  const loadError = options.error || rooms.error;
  const loading = options.loading || rooms.loading;
  function choose(next: Kind) {
    setKind(next);
    // Each class type sends only its own link: a certification or a workshop.
    setForm((current) => (next === "training" ? { ...current, catalogId: "" } : { ...current, certificationId: "" }));
    onDirty(true);
  }
  return (
    <Modal open title="Schedule a class" onClose={onClose}>
      <form className="class-form" onSubmit={(e) => void submit(e)}>
        {error ? (
          <p className="class-banner class-banner--error" role="alert">
            <AlertTriangle aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                catalog.reload();
                rooms.reload();
                workshops.reload();
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
          <div className="class-form__pair" role="radiogroup" aria-label="Class type">
            <label className="choice-card">
              <input
                type="radio"
                name="class-kind"
                checked={kind === "training"}
                onChange={() => choose("training")}
              />
              <span>
                <b>Equipment training</b>
                <small>Counts toward a certification</small>
              </span>
            </label>
            <label className="choice-card">
              <input
                type="radio"
                name="class-kind"
                checked={kind === "workshop"}
                onChange={() => choose("workshop")}
              />
              <span>
                <b>Creative workshop</b>
                <small>No certification</small>
              </span>
            </label>
          </div>
          {kind === "workshop" ? (
            <label className="class-field">
              <span>
                Workshop <em>(fills in title and description)</em>
              </span>
              <select value={form.catalogId} required onChange={(e) => set("catalogId", e.target.value)}>
                <option value="">Choose workshop</option>
                {workshops.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="class-field">
            <span>Title</span>
            <input value={form.title} required maxLength={100} onChange={(e) => set("title", e.target.value)} />
          </label>
          {kind === "training" ? (
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
                Configure training duration and the one-time training fee in <Link to="/training">Training</Link>.
              </small>
            </label>
          ) : null}
          <label className="class-field">
            <span>Description</span>
            <textarea
              rows={4}
              maxLength={DESCRIPTION_MAX}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
            <small className="class-field__meta">
              <span>Shown to members on the class page</span>
              <span>
                {form.description.length} / {DESCRIPTION_MAX}
              </span>
            </small>
          </label>
          {kind === "workshop" ? (
            <p className="class-banner">
              <Info aria-hidden="true" />
              <span>
                Creative workshops don't grant equipment certification. Members see the same note when they register.
              </span>
            </p>
          ) : null}
        </fieldset>
        {course && <p>{course.trainingMinutes ?? 60} minutes of training required. {course.trainingFeeCents == null ? 'Training fee not configured.' : `${cents(course.trainingFeeCents)} is charged once when a member registers for required training.`}</p>}
        <fieldset disabled={busy}>
          <legend>
            <i>2</i>When
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
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            <i>3</i>Where and who
          </legend>
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
                    {r.name} · {r.capacity ? `${r.capacity} seats` : r.location}
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
                max={Math.min(room?.capacity ?? MAX_SEATS, MAX_SEATS)}
                required
                value={form.capacity}
                onChange={(e) => set("capacity", e.target.value)}
              />
              <small>Max {MAX_SEATS} per class</small>
            </label>
          </div>
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
            <span>Reason for change</span>
            <input
              value={form.reason}
              required
              maxLength={500}
              placeholder="e.g. Sponsor workshop series"
              onChange={(e) => set("reason", e.target.value)}
            />
          </label>
        </fieldset>
        <div className="class-dialog-actions">
          <span>Members see it once published.</span>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={busy || Boolean(timeProblem) || loading || Boolean(loadError)}
          >
            {busy ? "Publishing…" : "Publish class"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
