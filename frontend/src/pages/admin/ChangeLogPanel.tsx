import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Award,
  Ban,
  CalendarRange,
  Check,
  Database,
  DoorOpen,
  FileText,
  History,
  Layers,
  Megaphone,
  Nfc,
  Receipt,
  UserRound,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { accessReasonLabel } from "../../lib/accessReadiness";
import {
  actionTitle,
  areaLabel,
  dateTimeIn,
  describeAudit,
  fieldLabel,
  formatFieldValue,
  type AuditArea,
  type AuditTone,
} from "../../lib/auditActions";
import type { Audit, AuditField, AuditRecord } from "../../lib/staffContracts";
import { addDays, dayKey, formatTime } from "../../lib/today";
import { useApi } from "../../lib/useApi";
import { LoadState } from "../../components/Management";

const AREA_ICONS: Record<AuditArea, LucideIcon> = {
  access: Nfc,
  accounts: UserRound,
  billing: Receipt,
  classes: Users,
  equipment: Wrench,
  memberships: Layers,
  notices: Megaphone,
  policies: FileText,
  reservations: CalendarRange,
  spaces: DoorOpen,
  training: Award,
  other: History,
};

function Marker({ tone, area }: { tone: AuditTone; area: AuditArea }) {
  const Icon = tone === "good" ? Check : tone === "bad" ? Ban : AREA_ICONS[area];
  return (
    <span className={`cl-marker is-${tone}`} aria-hidden="true">
      <Icon />
    </span>
  );
}

/** Days are already keyed in the shop's time zone; this only names them. */
function dayHeading(day: string, today: string) {
  const date = new Date(`${day}T12:00:00Z`);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const base = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
  if (day === today) return `Today · ${base}`;
  if (day === addDays(today, -1)) return `Yesterday · ${base}`;
  return base;
}

/** The records, newest first, under a heading for each day in the shop's time zone. */
export function AuditFeed({
  items,
  zone,
  today,
  selected,
  onSelect,
}: {
  items: Audit[];
  zone: string;
  today: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const days: { day: string; items: Audit[] }[] = [];
  for (const item of items) {
    const day = dayKey(Date.parse(item.createdAt), zone);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1)!.items.push(item);
  }
  return (
    <div className="cl-feed">
      {days.map((group) => (
        <section key={group.day} className="cl-day" aria-label={dayHeading(group.day, today)}>
          <h2 className="cl-day__head">
            <span>{dayHeading(group.day, today)}</span>
            <span className="cl-day__count">{group.items.length === 1 ? "1 record" : `${group.items.length} records`}</span>
          </h2>
          <ul className="cl-rows">
            {group.items.map((item) => {
              const info = describeAudit(item);
              const context = [item.subjectName, item.resourceName].filter(Boolean).join(" · ");
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="cl-row"
                    data-id={item.id}
                    aria-current={selected === item.id ? "true" : undefined}
                    onClick={() => onSelect(item.id)}
                  >
                    <Marker tone={info.tone} area={info.area} />
                    <span className="cl-row__body">
                      <span className="cl-row__title">
                        <span className="cl-row__name">{info.title}</span>
                        <span className="cl-area">{areaLabel(info.area)}</span>
                      </span>
                      {context ? <span className="cl-row__context">{context}</span> : null}
                      {item.accessReason ? <span className="cl-row__note">{accessReasonLabel(item.accessReason)}</span> : null}
                      <span className="cl-row__by">{item.actorName === "System" ? "Automatic" : `By ${item.actorName}`}</span>
                    </span>
                    <time className="cl-row__time" dateTime={item.createdAt}>
                      {formatTime(item.createdAt, zone)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FieldChange({ change, zone }: { change: AuditField; zone: string }) {
  const was = formatFieldValue(change.before, zone);
  const now = formatFieldValue(change.after, zone);
  return (
    <div className="cl-change">
      <dt>{fieldLabel(change.field)}</dt>
      <dd>
        <span className="cl-change__tag is-was">Was</span>
        <span className={was.empty ? "cl-change__empty" : "cl-change__was"}>{was.text}</span>
        <span className="cl-change__tag is-now">Now</span>
        <span className={now.empty ? "cl-change__empty" : "cl-change__now"}>{now.text}</span>
      </dd>
    </div>
  );
}

/** One record: who, why, what changed, and what was saved with it. */
export function ChangeLogPanel({
  id,
  zone,
  onSelect,
  onClose,
}: {
  id: string;
  zone: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const record = useApi<AuditRecord>(`/admin/audit/${id}`);
  const heading = useRef<HTMLHeadingElement>(null);
  const r = record.data?.id === id ? record.data : null;
  useEffect(() => {
    if (!r) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      if (window.matchMedia?.("(max-width: 1100px)").matches) heading.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [r]);
  const info = r ? describeAudit(r) : null;
  const ownRows = r?.related.filter((row) => row.source === "database") ?? [];
  const parents = r?.related.filter((row) => row.source === "application") ?? [];
  const reason = r?.reason && r.reason !== "Database change" ? r.reason : null;

  return (
    <aside className="today-panel cl-panel" aria-label="Change details">
      <div className="cl-panel__head">
        <div>
          <p className="eq-eyebrow">{r && info ? `${areaLabel(info.area)} · ${dateTimeIn(r.createdAt, zone)}` : "Change"}</p>
          <h2 ref={heading} tabIndex={-1}>
            {info?.title ?? "Loading…"}
          </h2>
        </div>
        <button type="button" className="icon-button icon-button--small" onClick={onClose} aria-label="Close details">
          <X aria-hidden="true" />
        </button>
      </div>
      <LoadState loading={record.loading && !r} error={record.error} reload={record.reload} />
      {r && info ? (
        <div className="cl-panel__body">
          <dl className="eq-facts cl-facts">
            <div>
              <dt>Changed by</dt>
              <dd>{r.actorName === "System" ? "Automatic" : r.actorName}</dd>
            </div>
            {r.subjectId && r.subjectName ? (
              <div>
                <dt>Member</dt>
                <dd>
                  <Link to={`/admin/members?member=${r.subjectId}`}>{r.subjectName}</Link>
                </dd>
              </div>
            ) : null}
            {r.resourceName ? (
              <div className="cl-facts__wide">
                <dt>About</dt>
                <dd>{r.resourceName}</dd>
              </div>
            ) : null}
          </dl>

          {reason ? (
            <section>
              <h3 className="cl-label">Reason given</h3>
              <p className="cl-quote">{reason}</p>
            </section>
          ) : null}
          {r.accessReason ? (
            <section>
              <h3 className="cl-label">Reader decision</h3>
              <p className="cl-quote">{accessReasonLabel(r.accessReason)}</p>
            </section>
          ) : null}

          {r.changes ? (
            <section>
              <h3 className="cl-label">
                What changed
                <span>
                  {r.changes.changed.length} of {r.changes.changed.length + r.changes.unchanged.length} fields
                </span>
              </h3>
              {r.changes.changed.length ? (
                <dl className="cl-changes">
                  {r.changes.changed.map((change) => (
                    <FieldChange key={change.field} change={change} zone={zone} />
                  ))}
                </dl>
              ) : (
                <p className="cl-muted">Nothing in the saved record changed.</p>
              )}
              {r.changes.unchanged.length ? (
                <details className="cl-more">
                  <summary>
                    {r.changes.unchanged.length} unchanged {r.changes.unchanged.length === 1 ? "field" : "fields"}
                  </summary>
                  <dl className="cl-unchanged">
                    {r.changes.unchanged.map((field) => (
                      <div key={field.field}>
                        <dt>{fieldLabel(field.field)}</dt>
                        <dd>{formatFieldValue(field.after, zone).text}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </section>
          ) : r.source === "database" ? (
            <p className="cl-muted">The database records which row was written, not its values.</p>
          ) : null}

          {parents.length ? (
            <section>
              <h3 className="cl-label">Part of</h3>
              <ul className="cl-related">
                {parents.map((row) => (
                  <li key={row.id}>
                    <button type="button" className="cl-related__open" onClick={() => onSelect(row.id)}>
                      {actionTitle(row.action)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {ownRows.length ? (
            <section>
              <h3 className="cl-label">{r.source === "application" ? "Saved with it" : "Written alongside"}</h3>
              <ul className="cl-related">
                {ownRows.map((row) => (
                  <li key={row.id}>
                    <Database aria-hidden="true" />
                    <button type="button" className="cl-related__open" onClick={() => onSelect(row.id)}>
                      {actionTitle(row.action)}
                    </button>
                    <code>
                      {row.entityType} #{row.entityId}
                    </code>
                  </li>
                ))}
                {r.relatedCount > r.related.length ? <li className="cl-muted">and {r.relatedCount - r.related.length} more</li> : null}
              </ul>
            </section>
          ) : null}

          <details className="cl-more">
            <summary>Technical details</summary>
            <dl className="cl-unchanged">
              <div>
                <dt>Event</dt>
                <dd>{r.action}</dd>
              </div>
              <div>
                <dt>Record</dt>
                <dd>
                  {r.entityType} #{r.entityId}
                </dd>
              </div>
              {r.readerId ? (
                <div>
                  <dt>Reader</dt>
                  <dd>{r.readerId}</dd>
                </div>
              ) : null}
              <div>
                <dt>Recorded by</dt>
                <dd>{r.source === "application" ? "The application" : "A database trigger"}</dd>
              </div>
              <div>
                <dt>Audit ID</dt>
                <dd>{r.id}</dd>
              </div>
            </dl>
          </details>
        </div>
      ) : null}
    </aside>
  );
}
