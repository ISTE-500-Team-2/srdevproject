import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "../components/Management";
import { dateTime } from "../lib/display";
import { MemberSelect } from "../components/MemberSelect";
type Class = {
  id: number;
  title: string;
  certificationId: number;
  certificationName: string;
  instructorId: number;
  instructor: string;
  capacity: number;
  enrolled: number;
  status: string;
  revision: number;
  roomId: number;
  roomName: string;
  startsAt: string;
  endsAt: string;
  myStatus: string | null;
};
type Person = { userId: number; name: string; email: string; status: string };
type MemberRoster = { items: { name: string }[]; capacity: number; enrolled: number; seatsAvailable: number };
type AttendanceDraft = { status: string; reason: string };
function withoutKey<T>(values: Record<string, T>, key: string) {
  const next = { ...values };
  delete next[key];
  return next;
}
export function ClassesPage() {
  const selectorId = useId();
  const { user } = useAuth();
  const classes = useApi<Class[]>(user ? "/classes" : null, { retainOnReload: true });
  const [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Class | null>(null);
  const [cancellationDrafts, setCancellationDrafts] = useState<Record<string, string>>({});
  const [attendanceDrafts, setAttendanceDrafts] = useState<Record<string, AttendanceDraft>>({});
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const hasUnsavedEdits = scheduleDirty || Object.keys(cancellationDrafts).length > 0 || Object.keys(attendanceDrafts).length > 0;
  const roles = user?.roles ?? [],
    staff = roles.some((r) => ["admin", "staff"].includes(r));
  const managesSelected = Boolean(selected && (staff || (roles.includes("instructor") && selected.instructorId === user?.id)));
  const roster = useApi<Person[]>(
    selected && managesSelected ? `/classes/${selected.id}/roster` : null, { retainOnReload: true },
  );
  const participants = useApi<MemberRoster>(
    selected && !managesSelected ? `/classes/${selected.id}/member-roster` : null, { retainOnReload: true },
  );
  const refreshClasses = () => { classes.reload(); roster.reload(); participants.reload(); };
  useEffect(() => {
    const refresh = () => {
      if (!hasUnsavedEdits && !busy && document.visibilityState !== "hidden") { classes.reload(); roster.reload(); participants.reload(); }
    };
    const timer = window.setInterval(refresh, 120000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [classes.reload, roster.reload, participants.reload, hasUnsavedEdits, busy]);
  const catalog = useApi<
    { id: number; name: string; validityDays: number | null }[]
  >(staff ? "/training/catalog" : null);
  const rooms = useApi<
    {
      id: number;
      name: string;
      location: string;
      capacity: number | null;
      status: string;
    }[]
  >(staff ? "/rooms" : null);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      classes.reload();
      roster.reload();
      participants.reload();
      setMessage("Class records saved.");
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api("/classes", {
        method: "POST",
        body: {
          title: f.get("title"),
          certificationId: Number(f.get("certId")),
          instructorId: Number(f.get("instructorId")),
          roomId: Number(f.get("roomId")),
          capacity: Number(f.get("capacity")),
          startsAt: new Date(String(f.get("startsAt"))).toISOString(),
          endsAt: new Date(String(f.get("endsAt"))).toISOString(),
          reason: f.get("reason"),
        },
      });
      setScheduleDirty(false);
    });
  }
  if (!user)
    return (
      <section>
        <h1>Classes</h1>
        <p>Sign in to view scheduled instructor-led training and register.</p>
        <Link to="/login">Sign in</Link>
      </section>
    );
  return (
    <section className="classes-page page-enter">
      <p className="eyebrow">Learn by making</p>
      <h1>Instructor-led classes</h1>
      <p>
        Signing up doesn't certify you. Your instructor confirms your training after the class.
      </p>
      {message ? <p role="status">{message}</p> : null}
      <label>
        Filter classes
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <LoadState {...classes} />
      {hasUnsavedEdits ? <p role="status">Automatic refresh is paused while you have unsaved edits. Manual refresh keeps your edits.</p> : null}
      <button className="button button--quiet" type="button" disabled={busy} onClick={refreshClasses}>Refresh classes and rosters</button>
      <div className="class-catalog">
        {classes.data
          ?.filter((c) =>
            (c.title + " " + c.instructor + " " + c.certificationName)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((c) => (
            <article className="catalog-card panel" key={c.id}>
              <div className="catalog-card__body">
                <p className="eyebrow">{c.certificationName}</p>
                <h2>{c.title}</h2>
                <p>
                  {c.instructor} · {c.roomName}
                </p>
                <p>
                  {dateTime(c.startsAt)} – {dateTime(c.endsAt)}
                </p>
                <p>
                  {c.enrolled} / {c.capacity} registered · {c.status}
                </p>
                <p>Your registration: {c.myStatus ?? "Not registered"}</p>
                {c.status === "scheduled" &&
                new Date(c.startsAt) > new Date() ? (
                  c.myStatus === "enrolled" ? (
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api(`/classes/${c.id}/withdraw`, {
                            method: "POST",
                            body: {},
                          }),
                        )
                      }
                    >
                      Withdraw from {c.title}
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={
                        busy ||
                        c.enrolled >= c.capacity ||
                        c.myStatus === "attended"
                      }
                      onClick={() =>
                        void run(() =>
                          api(`/classes/${c.id}/enroll`, {
                            method: "POST",
                            body: {},
                          }),
                        )
                      }
                    >
                      Register for {c.title}
                    </button>
                  )
                ) : null}
                {staff ||
                (roles.includes("instructor") && c.instructorId === user.id) ? (
                  <button
                    className="button button--quiet"
                    onClick={() => setSelected(c)}
                  >
                    View roster for {c.title}
                  </button>
                ) : c.status === "scheduled" && new Date(c.startsAt) > new Date() ? (
                  <button className="button button--quiet" onClick={() => setSelected(c)}>
                    View participants for {c.title}
                  </button>
                ) : null}
                {staff && c.status === "scheduled" ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void run(async () => {
                        await api(`/classes/${c.id}/cancel`, {
                          method: "POST",
                          body: {
                            expectedRevision: c.revision,
                            reason: f.get("reason"),
                          },
                        });
                        setCancellationDrafts(drafts => withoutKey(drafts, String(c.id)));
                      });
                    }}
                  >
                    <label>
                      Cancellation reason
                      <input name="reason" required disabled={busy}
                        value={cancellationDrafts[c.id] ?? ""}
                        onChange={e => setCancellationDrafts(drafts => e.target.value ? { ...drafts, [c.id]: e.target.value } : withoutKey(drafts, String(c.id)))} />
                    </label>
                    <button className="button button--quiet" disabled={busy}>
                      Cancel {c.title}
                    </button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
      </div>
      {classes.data?.length === 0 ? (
        <p>No scheduled classes have been published.</p>
      ) : null}
      {selected ? (
        <section aria-label={`${selected.title} ${managesSelected ? "roster" : "participants"}`}>
          <h2>{selected.title} {managesSelected ? "roster" : "participants"}</h2>
          <button
            className="button button--quiet"
            onClick={() => setSelected(null)}
          >
            Close roster
          </button>
          <LoadState {...(managesSelected ? roster : participants)} />
          {!managesSelected && participants.data ? (
            <>
              <p>{participants.data.enrolled} / {participants.data.capacity} registered · {participants.data.seatsAvailable} {participants.data.seatsAvailable === 1 ? "seat" : "seats"} available</p>
              <p>Participants are shown by first name and last initial.</p>
              {participants.data.items.length ? <ul>{participants.data.items.map((p,index) => <li key={index}>{p.name}</li>)}</ul> : <p>No participants registered yet.</p>}
            </>
          ) : null}
          {(managesSelected ? roster.data : null)?.map((p) => (
            <article className="saved-record" key={p.userId}>
              <h3>
                {p.name} · Member {p.userId}
              </h3>
              <p>
                {p.email} · {p.status}
              </p>
              {(roles.includes("admin") ||
                (roles.includes("instructor") &&
                  selected.instructorId === user.id)) &&
              selected.status === "scheduled" &&
              new Date(selected.startsAt) <= new Date() &&
              p.status !== "cancelled" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const key = `${selected.id}:${p.userId}`;
                    void run(async () => {
                      await api(`/classes/${selected.id}/attendance`, {
                        method: "POST",
                        body: {
                          userId: p.userId,
                          status: f.get("status"),
                          reason: f.get("reason"),
                        },
                      });
                      setAttendanceDrafts(drafts => withoutKey(drafts, key));
                    });
                  }}
                >
                  <label>
                    Observed attendance
                    <select name="status" disabled={busy}
                      value={attendanceDrafts[`${selected.id}:${p.userId}`]?.status ?? (p.status === "no_show" ? "no_show" : "attended")}
                      onChange={e => {
                        const key = `${selected.id}:${p.userId}`;
                        const status = e.target.value;
                        setAttendanceDrafts(drafts => {
                          const next = { status, reason: drafts[key]?.reason ?? "" };
                          return next.reason || status !== (p.status === "no_show" ? "no_show" : "attended") ? { ...drafts, [key]: next } : withoutKey(drafts, key);
                        });
                      }}>
                      <option value="attended">Attended</option>
                      <option value="no_show">No show</option>
                    </select>
                  </label>
                  <label>
                    Verification note
                    <input name="reason" required disabled={busy}
                      value={attendanceDrafts[`${selected.id}:${p.userId}`]?.reason ?? ""}
                      onChange={e => {
                        const key = `${selected.id}:${p.userId}`;
                        const reason = e.target.value;
                        setAttendanceDrafts(drafts => {
                          const status = drafts[key]?.status ?? (p.status === "no_show" ? "no_show" : "attended");
                          return reason || status !== (p.status === "no_show" ? "no_show" : "attended") ? { ...drafts, [key]: { status, reason } } : withoutKey(drafts, key);
                        });
                      }} />
                  </label>
                  <button className="button" disabled={busy}>
                    Save attendance for {p.name}
                  </button>
                </form>
              ) : null}
            </article>
          ))}
          {managesSelected ? <Link to="/training">Approve completed training</Link> : null}
        </section>
      ) : null}
      {staff ? (
        <form className="management-form" onSubmit={create} onChange={() => setScheduleDirty(true)}>
          <h2>Schedule training</h2>
          <label>
            Title
            <input name="title" required maxLength={100} />
          </label>
          <LoadState {...catalog} />
          <LoadState {...rooms} />
          <label htmlFor={selectorId + '-certification'}>Certification</label>
            <select id={selectorId + '-certification'} name="certId" required>
              <option value="">Choose certification</option>
              {catalog.data
                ?.filter((c) => c.validityDays)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          <MemberSelect
            name="instructorId"
            label="Assigned instructor"
            instructorsOnly
          />
          <label htmlFor={selectorId + '-room'}>Room</label>
            <select id={selectorId + '-room'} name="roomId" required>
              <option value="">Choose room</option>
              {rooms.data
                ?.filter((room) => room.status === "available")
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name} — {room.location} (capacity{" "}
                    {room.capacity ?? "not configured"})
                  </option>
                ))}
            </select>
          <label>
            Capacity
            <input name="capacity" type="number" min={1} max={500} required />
          </label>
          <label>
            Starts
            <input name="startsAt" type="datetime-local" required />
          </label>
          <label>
            Ends
            <input name="endsAt" type="datetime-local" required />
          </label>
          <label>
            Scheduling reason
            <input name="reason" required maxLength={500} />
          </label>
          <button
            className="button"
            disabled={
              busy ||
              catalog.loading ||
              rooms.loading ||
              !!catalog.error ||
              !!rooms.error
            }
          >
            Publish class
          </button>
          <p>
            Room conflicts and capacity are checked before saving. Configure
            training validity in <Link to="/training">Training management</Link>
            .
          </p>
        </form>
      ) : null}
    </section>
  );
}
