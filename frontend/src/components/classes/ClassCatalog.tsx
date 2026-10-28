import { AlertTriangle, Award, Ban, Check, Clock3, GraduationCap, Lock, MapPin, Search, ShieldCheck, UserRound, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ClassThumb, DateRail, SeatMeter } from "./ClassBits";
import {
  byStart,
  enrollmentLabel,
  hasStarted,
  isCancelled,
  monthLabel,
  seatsLeft,
  timeRange,
  type ClassRecord,
} from "./classData";
import { shortDate } from "../../lib/display";

export type Eligibility = "eligible" | "ineligible" | "unknown";

type Props = {
  classes: ClassRecord[];
  eligibility: Eligibility;
  certified: Set<number>;
  busyId: number | null;
  errors: Record<number, string>;
  teaching: ClassRecord[];
  onRegister: (c: ClassRecord) => void;
  onWithdraw: (c: ClassRecord) => void;
  onDetails: (c: ClassRecord) => void;
  onRoster: (c: ClassRecord) => void;
};

export function ClassCatalog(props: Props) {
  const { classes, eligibility, teaching, onWithdraw, onRoster, busyId } = props;
  const [query, setQuery] = useState("");
  const [certification, setCertification] = useState<string | null>(null);
  const upcoming = useMemo(() => classes.filter((c) => !hasStarted(c)).sort(byStart), [classes]);
  const mine = upcoming.filter((c) => c.myStatus === "enrolled" && !isCancelled(c));
  const past = classes
    .filter((c) => hasStarted(c) && c.myStatus && c.myStatus !== "cancelled")
    .sort((a, b) => byStart(b, a));
  const certifications = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of upcoming) counts.set(c.certificationName, (counts.get(c.certificationName) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [upcoming]);
  const needle = query.trim().toLowerCase();
  const shown = upcoming.filter(
    (c) =>
      (!certification || c.certificationName === certification) &&
      (!needle || `${c.title} ${c.instructor} ${c.certificationName}`.toLowerCase().includes(needle)),
  );
  const months = new Map<string, ClassRecord[]>();
  for (const c of shown) {
    const key = monthLabel(c.startsAt);
    months.set(key, [...(months.get(key) ?? []), c]);
  }

  return (
    <>
      <div className="classes-head">
        <div>
          <p className="eyebrow">Learn by making</p>
          <h1 className="display-heading">Classes</h1>
          <p className="classes-head__lead">
            Hands-on sessions with a shop instructor. Each class prepares you for one certification. Approval is a
            separate step after class.
          </p>
        </div>
        {upcoming.length ? (
          <label className="class-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search classes</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search classes or instructors"
            />
          </label>
        ) : null}
      </div>
      {certifications.length > 1 ? (
        <div className="class-filters" role="group" aria-label="Filter by certification">
          <button
            type="button"
            className="class-chip"
            aria-pressed={certification === null}
            onClick={() => setCertification(null)}
          >
            All <em>{upcoming.length}</em>
          </button>
          {certifications.map(([name, count]) => (
            <button
              type="button"
              key={name}
              className="class-chip"
              aria-pressed={certification === name}
              onClick={() => setCertification(certification === name ? null : name)}
            >
              {name} <em>{count}</em>
            </button>
          ))}
        </div>
      ) : null}

      <div className="classes-layout">
        <div className="classes-main">
          {!upcoming.length ? (
            <div className="classes-empty">
              <span className="classes-empty__icon" aria-hidden="true">
                <GraduationCap />
              </span>
              <h2>No classes on the schedule</h2>
              <p>New sessions are posted here. In the meantime you can book any equipment you're already certified on.</p>
              <Link className="button button--quiet" to="/equipment">
                Book equipment
              </Link>
            </div>
          ) : !shown.length ? (
            <div className="classes-empty classes-empty--small">
              <h2>No classes match</h2>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  setQuery("");
                  setCertification(null);
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            [...months].map(([month, items]) => (
              <section className="class-month" key={month} aria-label={month}>
                <div className="class-month__heading">
                  <h2>{month}</h2>
                  <span>
                    {items.length} {items.length === 1 ? "class" : "classes"}
                  </span>
                </div>
                <ul className="class-rows">
                  {items.map((c) => (
                    <ClassRow key={c.id} c={c} {...props} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <aside className="classes-aside">
          {mine.length || past.length ? (
            <section className="panel classes-aside__panel classes-aside__panel--first" aria-labelledby="your-classes">
              <h2 id="your-classes">Your classes</h2>
              {mine.length ? (
                <ul className="your-classes">
                  {mine.map((c) => (
                    <li key={c.id}>
                      <DateRail value={c.startsAt} />
                      <div>
                        <strong>{c.title}</strong>
                        <span>{timeRange(c)}</span>
                        <button
                          type="button"
                          className="button button--quiet button--small"
                          disabled={busyId === c.id}
                          aria-label={`Withdraw from ${c.title}`}
                          onClick={() => onWithdraw(c)}
                        >
                          Withdraw
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="classes-aside__muted">You're not registered for an upcoming class.</p>
              )}
              {past.length ? (
                <details className="your-classes__past">
                  <summary>Past classes ({past.length})</summary>
                  <ul>
                    {past.map((c) => (
                      <li key={c.id}>
                        <span>
                          {c.title} · {shortDate(c.startsAt)}
                        </span>
                        <em>{c.myStatus === "enrolled" ? "Attendance not recorded yet" : enrollmentLabel(c.myStatus!)}</em>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}

          {teaching.length ? (
            <section className="panel classes-aside__panel classes-aside__panel--first" aria-labelledby="teaching">
              <h2 id="teaching">Classes you teach</h2>
              <ul className="your-classes">
                {teaching.map((c) => (
                  <li key={c.id}>
                    <DateRail value={c.startsAt} />
                    <div>
                      <strong>{c.title}</strong>
                      <span>
                        {c.enrolled}/{c.capacity} registered
                      </span>
                      <button
                        type="button"
                        className="button button--quiet button--small"
                        aria-label={`Roster for ${c.title}`}
                        onClick={() => onRoster(c)}
                      >
                        <Users aria-hidden="true" />
                        Roster
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel classes-aside__panel" aria-labelledby="class-steps">
            <h2 id="class-steps">From class to certification</h2>
            <ol className="class-steps">
              <li>
                <b>Register</b>
                <span>Saves your seat. You can withdraw any time before it starts.</span>
              </li>
              <li>
                <b>Attend</b>
                <span>Your instructor records who was there.</span>
              </li>
              <li>
                <b>Get approved</b>
                <span>
                  An instructor verifies your training in person. Once approved, it shows on{" "}
                  <Link to="/certifications">Certifications &amp; Waivers</Link>.
                </span>
              </li>
            </ol>
          </section>

          {eligibility !== "unknown" ? (
            <section className={`panel classes-aside__panel classes-access classes-access--${eligibility}`}>
              <span className="classes-access__icon" aria-hidden="true">
                {eligibility === "eligible" ? <Check /> : <Lock />}
              </span>
              <div>
                <h2>{eligibility === "eligible" ? "You can register" : "Membership or day pass needed"}</h2>
                <p>
                  {eligibility === "eligible"
                    ? "Classes need an active membership or day pass. Yours is active."
                    : "Registering for a class needs an active membership or day pass."}
                </p>
                {eligibility === "ineligible" ? (
                  <Link className="button button--quiet button--small" to="/membership">
                    See memberships &amp; day passes
                  </Link>
                ) : null}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function ClassRow({
  c,
  eligibility,
  certified,
  busyId,
  errors,
  onRegister,
  onDetails,
}: Props & { c: ClassRecord }) {
  const cancelled = isCancelled(c);
  const registered = c.myStatus === "enrolled";
  const full = seatsLeft(c) === 0;
  const holds = certified.has(c.certificationId);
  const busy = busyId === c.id;
  return (
    <li className={`class-row${registered && !cancelled ? " class-row--mine" : ""}${cancelled ? " class-row--cancelled" : ""}`}>
      <DateRail value={c.startsAt} faded={cancelled} />
      <ClassThumb certification={c.certificationName} />
      <div className="class-row__info">
        <h3>{c.title}</h3>
        <div className="class-row__tags">
          <span className="class-cert">
            <Award aria-hidden="true" />
            {c.certificationName}
          </span>
          {cancelled ? (
            <span className="status-pill status-pill--danger">
              <Ban aria-hidden="true" />
              Cancelled
            </span>
          ) : registered ? (
            <span className="status-pill status-pill--mine">
              <Check aria-hidden="true" />
              Registered
            </span>
          ) : holds ? (
            <span className="status-pill status-pill--ok">
              <ShieldCheck aria-hidden="true" />
              You're certified
            </span>
          ) : null}
        </div>
        <p className="class-meta">
          <span>
            <Clock3 aria-hidden="true" />
            {timeRange(c)}
          </span>
          <span>
            <MapPin aria-hidden="true" />
            {c.roomName}
          </span>
          {cancelled ? null : (
            <span>
              <UserRound aria-hidden="true" />
              {c.instructor}
            </span>
          )}
        </p>
      </div>
      {cancelled ? (
        <p className="class-row__cancelled">The shop cancelled this class.</p>
      ) : (
        <>
          <SeatMeter capacity={c.capacity} enrolled={c.enrolled} />
          <div className="class-row__actions">
            {registered ? (
              <button type="button" className="button button--quiet" aria-label={`Details for ${c.title}`} onClick={() => onDetails(c)}>
                Details
              </button>
            ) : full ? (
              <button type="button" className="button button--quiet" disabled>
                Class full
              </button>
            ) : eligibility === "ineligible" ? (
              <Link className="button button--quiet" to="/membership">
                Membership or day pass needed
              </Link>
            ) : (
              <button
                type="button"
                className={`button ${holds ? "button--quiet" : "button--primary"}`}
                disabled={busy}
                aria-label={`Register for ${c.title}`}
                onClick={() => onRegister(c)}
              >
                {c.myStatus === "cancelled" ? "Register again" : "Register"}
              </button>
            )}
            {registered ? null : (
              <button type="button" className="text-link" aria-label={`Details for ${c.title}`} onClick={() => onDetails(c)}>
                Details
              </button>
            )}
            {!registered && c.myStatus === "cancelled" ? <small>You withdrew earlier</small> : null}
            {!registered && holds && !full ? <small>Good for a refresher</small> : null}
          </div>
        </>
      )}
      {errors[c.id] ? (
        <p className="class-row__error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {errors[c.id]}
        </p>
      ) : null}
    </li>
  );
}
