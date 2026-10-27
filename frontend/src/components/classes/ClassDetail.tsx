import { CalendarDays, Clock3, Info, MapPin, UserRound } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../Modal";
import { SeatMeter } from "./ClassBits";
import { classImage, hasStarted, isCancelled, longDate, seatsLeft, timeRange, type ClassRecord, type MemberRoster } from "./classData";
import { useApi } from "../../lib/useApi";
import type { Eligibility } from "./ClassCatalog";

export function ClassDetail({
  c,
  eligibility,
  busy,
  error,
  refreshToken,
  onClose,
  onRegister,
  onWithdraw,
}: {
  c: ClassRecord;
  eligibility: Eligibility;
  busy: boolean;
  error?: string;
  refreshToken: number;
  onClose: () => void;
  onRegister: (c: ClassRecord) => void;
  onWithdraw: (c: ClassRecord) => void;
}) {
  const open = !isCancelled(c) && !hasStarted(c);
  // Members only ever see first name + last initial, never contact details.
  const participants = useApi<MemberRoster>(open ? `/classes/${c.id}/member-roster` : null, { retainOnReload: true });
  const reloadParticipants = participants.reload;
  useEffect(() => {
    if (refreshToken) reloadParticipants();
  }, [refreshToken, reloadParticipants]);
  const image = classImage(c.certificationName);
  const counts = participants.data ?? { capacity: c.capacity, enrolled: c.enrolled };
  const registered = c.myStatus === "enrolled";
  return (
    <Modal open title={c.title} onClose={onClose}>
      <div className="class-detail" role="region" aria-label={`${c.title} details`}>
        {image ? (
          <div className={`class-detail__hero${image.cutout ? " class-detail__hero--cutout" : ""}`}>
            <img src={image.src} alt="" />
          </div>
        ) : null}
        <p className="eyebrow">Counts toward {c.certificationName}</p>
        <dl className="class-facts">
          <div>
            <CalendarDays aria-hidden="true" />
            <dt>Date</dt>
            <dd>{longDate(c.startsAt)}</dd>
          </div>
          <div>
            <Clock3 aria-hidden="true" />
            <dt>Time</dt>
            <dd>{timeRange(c)}</dd>
          </div>
          <div>
            <UserRound aria-hidden="true" />
            <dt>Instructor</dt>
            <dd>{c.instructor}</dd>
          </div>
          <div>
            <MapPin aria-hidden="true" />
            <dt>Room</dt>
            <dd>{c.roomName}</dd>
          </div>
        </dl>
        {open ? (
          <>
            <SeatMeter capacity={counts.capacity} enrolled={counts.enrolled} />
            <h3 className="class-detail__label">Who's going</h3>
            {participants.error ? <p role="alert">{participants.error}</p> : null}
            {participants.data ? (
              participants.data.items.length ? (
                <ul className="class-people">
                  {participants.data.items.map((p, index) => (
                    <li key={index}>{p.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="class-detail__muted">Nobody has registered yet.</p>
              )
            ) : null}
          </>
        ) : (
          <p className="class-detail__muted">{isCancelled(c) ? "The shop cancelled this class." : "This class has started. Registration is closed."}</p>
        )}
        <p className="class-note">
          <Info aria-hidden="true" />
          <span>
            Registering saves your seat. Attending doesn't certify you on its own. <b>{c.certificationName}</b> is
            approved separately, after an instructor verifies your training.
          </span>
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {open ? (
        <div className="class-dialog-actions">
          <span>You can withdraw any time before it starts</span>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
          {registered ? (
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => onWithdraw(c)}>
              Withdraw
            </button>
          ) : seatsLeft(counts) === 0 ? (
            <button type="button" className="button button--quiet" disabled>
              Class full
            </button>
          ) : eligibility === "ineligible" ? (
            <Link className="button button--primary" to="/membership">
              See memberships &amp; day passes
            </Link>
          ) : (
            <button type="button" className="button button--primary" disabled={busy} onClick={() => onRegister(c)}>
              {c.myStatus === "cancelled" ? "Register again" : "Register for class"}
            </button>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
