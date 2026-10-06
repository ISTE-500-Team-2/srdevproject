import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState, dateTime } from "../components/Management";
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
export function ClassesPage() {
  const { user } = useAuth();
  const classes = useApi<Class[]>(user ? "/classes" : null);
  const [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Class | null>(null);
  const roster = useApi<Person[]>(
    selected ? `/classes/${selected.id}/roster` : null,
  );
  const roles = user?.roles ?? [],
    staff = roles.some((r) => ["admin", "staff"].includes(r));
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      classes.reload();
      roster.reload();
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
    await run(() =>
      api("/classes", {
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
      }),
    );
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
        Registration does not grant certification. The assigned instructor
        records attendance and separately approves completed in-person training.
      </p>
      {message ? <p role="status">{message}</p> : null}
      <label>
        Filter classes
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <LoadState {...classes} />
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
                ) : null}
                {staff && c.status === "scheduled" ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void run(() =>
                        api(`/classes/${c.id}/cancel`, {
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
                      Cancellation reason
                      <input name="reason" required />
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
        <section>
          <h2>{selected.title} roster</h2>
          <button
            className="button button--quiet"
            onClick={() => setSelected(null)}
          >
            Close roster
          </button>
          <LoadState {...roster} />
          {roster.data?.map((p) => (
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
                    void run(() =>
                      api(`/classes/${selected.id}/attendance`, {
                        method: "POST",
                        body: {
                          userId: p.userId,
                          status: f.get("status"),
                          reason: f.get("reason"),
                        },
                      }),
                    );
                  }}
                >
                  <label>
                    Observed attendance
                    <select name="status" defaultValue="attended">
                      <option value="attended">Attended</option>
                      <option value="no_show">No show</option>
                    </select>
                  </label>
                  <label>
                    Verification note
                    <input name="reason" required />
                  </label>
                  <button className="button" disabled={busy}>
                    Save attendance for {p.name}
                  </button>
                </form>
              ) : null}
            </article>
          ))}
          <Link to="/training">Approve completed training</Link>
        </section>
      ) : null}
      {staff ? (
        <form className="management-form" onSubmit={create}>
          <h2>Schedule training</h2>
          <label>
            Title
            <input name="title" required maxLength={100} />
          </label>
          <label>
            Certification ID
            <input type="number" name="certId" min={1} required />
          </label>
          <label>
            Assigned instructor ID
            <input name="instructorId" type="number" min={1} required />
          </label>
          <label>
            Room ID
            <input name="roomId" type="number" min={1} required />
          </label>
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
          <button className="button" disabled={busy}>
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
