import { CalendarDays, Clock3, Info, MapPin, UserRound } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../Modal";
import { SeatMeter } from "./ClassBits";
import { classPhoto, hasStarted, isCancelled, longDate, registrationPrice, timeRange, type ClassRecord, type MemberRoster, type WorkshopTemplate } from "./classData";
import { useApi } from "../../lib/useApi";
import { cents } from '../../lib/display';
import { registrationAction, type Eligibility } from "./registrationAction";

export function ClassDetail({
  c,
  workshops,
  eligibility,
  certified,
  busy,
  error,
  refreshToken,
  onClose,
  onRegister,
  onWithdraw,
}: {
  c: ClassRecord;
  /** The workshop catalog, so a renamed workshop session keeps its photo. */
  workshops?: WorkshopTemplate[];
  eligibility: Eligibility;
  certified: boolean;
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
  const image = classPhoto(c, workshops);
  const counts = participants.data ?? { capacity: c.capacity, enrolled: c.enrolled };
  const registered = c.myStatus === "enrolled";
  const price = registered ? { trainingFee: c.myTrainingFeeCents ?? 0 } : registrationPrice(c, certified);
  const action = registrationAction({ c, eligibility, certified, busy, seats: counts });
  return (
    <Modal open title={c.title} onClose={onClose}>
      <div className="class-detail" role="region" aria-label={`${c.title} details`}>
        <div className={`class-detail__hero${image.cutout ? " class-detail__hero--cutout" : ""}`}>
          <img src={image.src} alt="" />
        </div>
        <p className="eyebrow">{c.certificationId ? `Counts toward ${c.certificationName}` : "Creative workshop"}</p>
        {c.description && <p>{c.description}</p>}
        {c.certificationId !== null && <>
          {c.trainingMinutes && <p>{c.trainingMinutes} minutes of training required.</p>}
          <section aria-label="Class price breakdown">
            <p>One-time training fee: {price.trainingFee === null ? 'Not configured' : cents(price.trainingFee)}</p>
            <p><strong>Total: {price.trainingFee === null ? 'Not configured' : cents(price.trainingFee)}</strong></p>
            {registered && <p>Payment: {c.myPaymentStatus ?? 'not required'}</p>}
            <p>The displayed amount is the full one-time training price per equipment certification, with no extra course fee. Previously paid or completed training is not charged again. Equipment bookings only charge the hourly rate. Payment is recorded at the front desk.</p>
          </section>
        </>}
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
            {c.certificationId ? <>Registering saves your seat. Attending doesn't certify you on its own. <b>{c.certificationName}</b> is
            approved separately, after an instructor verifies your training.</> : 'Registering saves your workshop seat. This creative workshop does not grant equipment certification.'}
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
          <span>{action.kind !== "registered" && action.blocked ? action.blocked.reason : "You can withdraw any time before it starts"}</span>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
          {action.kind === "registered" ? (
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => onWithdraw(c)}>
              Withdraw
            </button>
          ) : action.kind === "full" ? (
            <button type="button" className="button button--quiet" disabled>
              Class full
            </button>
          ) : action.kind === "needs-pass" ? (
            <Link className="button button--primary" to="/membership">
              See memberships &amp; day passes
            </Link>
          ) : (
            <button type="button" className="button button--primary" disabled={action.disabled} onClick={() => onRegister(c)}>
              {action.again ? "Register again" : "Register for class"}
            </button>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
