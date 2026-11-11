import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Megaphone, Nfc, RefreshCw, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { LoadState, Pager } from "../../components/Management";
import { Modal } from "../../components/Modal";
import { Toast } from "../../components/Toast";
import { useAuth } from "../../context/AuthContext";
import { api, errorMessage } from "../../lib/api";
import {
  FLAKY_READER_DROPS,
  durationLabel,
  historyRows,
  monthDay,
  openFor,
  people,
  readerLabel,
  totalDown,
  type HistoryRow,
  type ServiceNotice,
  type ServiceNoticePage,
} from "../../lib/serviceNotices";
import { dayKey, formatTime } from "../../lib/today";
import { useApi } from "../../lib/useApi";
import "./serviceNotices.css";

const periods = [
  { value: "7d", label: "Past 7 days", phrase: "in the past 7 days" },
  { value: "30d", label: "Past 30 days", phrase: "in the past 30 days" },
  { value: "all", label: "All time", phrase: "in total" },
] as const;
type Period = (typeof periods)[number]["value"];
type Source = "" | "reader" | "staff";

/** Staff see what's broken now and what broke before; administrators tell members about it. */
export function ServiceNotices() {
  const { user } = useAuth();
  const isAdmin = !!user?.roles.includes("admin");
  const config = useApi<{ timeZone: string }>("/config", { reuse: true });
  const zone = config.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [period, setPeriod] = useState<Period>("30d");
  const [source, setSource] = useState<Source>("");
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ period, offset: String(offset) });
  if (source) query.set("source", source);
  // Readers recover on their own, so keep the page current without a reload.
  const notices = useApi<ServiceNoticePage>(`/admin/service-notices?${query}`, { retainOnReload: true, refreshInterval: 60000 });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const [composing, setComposing] = useState(false);
  const [resolving, setResolving] = useState<ServiceNotice | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const page = notices.data;
  const refilter = (change: () => void) => {
    change();
    setOffset(0);
  };

  return (
    <section className="today notices">
      <header className="notices-head">
        <div>
          {page ? <Verdict open={page.open} now={now} /> : null}
          <p className="notices-sub">
            Card readers that stop reporting in email staff automatically. Members only hear about problems you
            announce. An outage of this whole site can't send its own notice.
          </p>
        </div>
        {isAdmin ? (
          <button type="button" className="button button--quiet notices-compose" onClick={() => setComposing(true)}>
            <Megaphone aria-hidden="true" />
            Tell members about a problem
          </button>
        ) : (
          <p className="notices-admin-only">Only administrators can email members.</p>
        )}
      </header>

      <LoadState {...notices} loading={notices.loading && !page} />
      {page ? (
        <>
          <OpenPanel notices={page.open} now={now} zone={zone} isAdmin={isAdmin} onResolve={setResolving} />
          <HistoryPanel
            page={page}
            zone={zone}
            period={period}
            source={source}
            offset={offset}
            onPeriod={(next) => refilter(() => setPeriod(next))}
            onSource={(next) => refilter(() => setSource(next))}
            onOffset={setOffset}
          />
        </>
      ) : null}

      {isAdmin ? (
        <>
          <ComposeDialog
            open={composing}
            onClose={() => setComposing(false)}
            onSent={(recipients) => {
              setComposing(false);
              setToast(recipients === null ? "Sent to everyone." : `Sent to ${people(recipients, "person")}.`);
              notices.reload();
            }}
          />
          <ResolveDialog
            notice={resolving}
            onClose={() => setResolving(null)}
            onSent={() => {
              setResolving(null);
              setToast("Told everyone it's fixed.");
              notices.reload();
            }}
          />
        </>
      ) : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}

function Verdict({ open, now }: { open: ServiceNotice[]; now: number }) {
  if (!open.length)
    return (
      <p className="notices-verdict">
        <span className="notices-dot notices-dot--ok" aria-hidden="true" />
        Nothing is wrong right now.
      </p>
    );
  // An offline reader leads, since it is turning people away; then the longest-running problem.
  const readers = open.filter((notice) => notice.source === "reader");
  const oldest = (readers.length ? readers : open).reduce((a, b) => (Date.parse(a.openedAt) <= Date.parse(b.openedAt) ? a : b));
  const lasting = durationLabel(openFor(oldest, now));
  const lead =
    oldest.source === "reader"
      ? `${readerLabel(oldest)} has been offline for ${lasting}.`
      : `Members were told about a problem ${lasting} ago.`;
  return (
    <p className="notices-verdict">
      <span className="notices-dot" aria-hidden="true" />
      {open.length === 1 ? "1 problem open" : `${open.length} problems open`}: {lead}
    </p>
  );
}

function OpenPanel({
  notices,
  now,
  zone,
  isAdmin,
  onResolve,
}: {
  notices: ServiceNotice[];
  now: number;
  zone: string;
  isAdmin: boolean;
  onResolve: (notice: ServiceNotice) => void;
}) {
  return (
    <section className="today-panel" aria-labelledby="notices-open-title">
      <div className="today-panel-head">
        <h2 id="notices-open-title">Happening now</h2>
        {notices.length ? <span className="today-count today-count--hot">{notices.length}</span> : null}
      </div>
      {notices.length ? (
        notices.map((notice) =>
          notice.source === "reader" ? (
            <ReaderAlert key={notice.id} notice={notice} now={now} zone={zone} />
          ) : (
            <Announcement key={notice.id} notice={notice} now={now} isAdmin={isAdmin} onResolve={onResolve} />
          ),
        )
      ) : (
        <p className="today-empty">Every card reader is reporting in and no problems have been announced.</p>
      )}
    </section>
  );
}

function ReaderAlert({ notice, now, zone }: { notice: ServiceNotice; now: number; zone: string }) {
  const seen = notice.readerLastSeenAt;
  const lastSeen = seen
    ? dayKey(Date.parse(seen), zone) === dayKey(now, zone)
      ? formatTime(seen, zone)
      : `${monthDay(seen, zone)}, ${formatTime(seen, zone)}`
    : null;
  const drops = notice.recentDrops ?? 0;
  return (
    <div className="today-todo notices-item">
      <span className="today-todo-icon today-todo-icon--alert" aria-hidden="true">
        <Nfc />
      </span>
      <div>
        <span className="today-todo-title notices-title">
          {readerLabel(notice)}
          <span className="status-pill notices-pill--down">Offline</span>
        </span>
        <p className="today-todo-detail">
          Offline {durationLabel(openFor(notice, now))}
          {lastSeen ? ` · last seen ${lastSeen}` : ""} · refusing taps until it reconnects
        </p>
        {drops >= FLAKY_READER_DROPS ? (
          <p className="notices-flaky">
            <TriangleAlert aria-hidden="true" />
            Dropped out {drops} times in the last 24 hours. Check its power and network.
          </p>
        ) : null}
        <div className="notices-chips">
          <span className="notices-chip">
            <ShieldCheck aria-hidden="true" />
            {notice.recipients === null ? "Emailed staff" : `Emailed ${people(notice.recipients, "staff")}`}
          </span>
          <span className="notices-chip">
            <RefreshCw aria-hidden="true" />
            Clears itself when it reconnects
          </span>
        </div>
      </div>
      <Link className="today-button notices-action" to="/admin/access?view=readers">
        Check reader
        <ChevronRight aria-hidden="true" />
      </Link>
    </div>
  );
}

function Announcement({
  notice,
  now,
  isAdmin,
  onResolve,
}: {
  notice: ServiceNotice;
  now: number;
  isAdmin: boolean;
  onResolve: (notice: ServiceNotice) => void;
}) {
  return (
    <div className="today-todo notices-item">
      <span className="today-todo-icon" aria-hidden="true">
        <Megaphone />
      </span>
      <div>
        <span className="today-todo-title notices-title">
          {notice.summary}
          <span className="status-pill status-pill--warn">Announced</span>
        </span>
        <div className="notices-chips">
          <span className="notices-chip notices-chip--everyone">
            <Users aria-hidden="true" />
            {notice.recipients === null ? "Emailed everyone" : `Emailed ${people(notice.recipients, "person")}`}
          </span>
          <span className="notices-chip">
            Sent{notice.openedBy ? ` by ${notice.openedBy}` : ""} · {durationLabel(openFor(notice, now))} ago
          </span>
        </div>
      </div>
      {isAdmin ? (
        <button
          type="button"
          className="today-button notices-action"
          aria-label={`Mark fixed: ${notice.summary}`}
          onClick={() => onResolve(notice)}
        >
          Mark fixed
        </button>
      ) : null}
    </div>
  );
}

function HistoryPanel({
  page,
  zone,
  period,
  source,
  offset,
  onPeriod,
  onSource,
  onOffset,
}: {
  page: ServiceNoticePage;
  zone: string;
  period: Period;
  source: Source;
  offset: number;
  onPeriod: (period: Period) => void;
  onSource: (source: Source) => void;
  onOffset: (offset: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rows = historyRows(page.items, zone);
  const phrase = periods.find((p) => p.value === period)!.phrase;
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const filtered = period !== "all" || source !== "";
  return (
    <section className="today-panel" aria-labelledby="notices-history-title">
      <div className="today-panel-head notices-history-head">
        <h2 id="notices-history-title">History</h2>
        <div className="notices-filters" role="group" aria-label="Filter history">
          <label>
            <span className="sr-only">Period</span>
            <select value={period} onChange={(e) => onPeriod(e.target.value as Period)}>
              {periods.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Source</span>
            <select value={source} onChange={(e) => onSource(e.target.value as Source)}>
              <option value="">All sources</option>
              <option value="reader">Card readers</option>
              <option value="staff">Announcements</option>
            </select>
          </label>
        </div>
      </div>
      {rows.length ? (
        <div className="notices-table table-scroll" role="region" aria-label="Past notices" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Problem</th>
                <th scope="col">Who was told</th>
                <th scope="col">Opened</th>
                <th scope="col">Down for</th>
                <th scope="col">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <HistoryLine key={row.key} row={row} zone={zone} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="today-empty">No problems were recorded {phrase}{source ? " from this source" : ""}.</p>
      )}
      <div className="today-panel-foot notices-foot">
        <span>
          {page.total === null
            ? ""
            : `${page.total} ${page.total === 1 ? "notice" : "notices"} ${phrase}${filtered && source ? ` from ${source === "reader" ? "card readers" : "announcements"}` : ""}`}
        </span>
        <Pager offset={offset} nextOffset={page.nextOffset} onChange={onOffset} />
      </div>
    </section>
  );
}

function HistoryLine({ row, zone, open, onToggle }: { row: HistoryRow; zone: string; open: boolean; onToggle: () => void }) {
  const detailId = `notice-${row.key}`;
  const first = row.kind === "reader" ? row.drops[row.drops.length - 1]! : row.notice;
  const toggle = (label: string) => (
    <button
      type="button"
      className="notices-toggle"
      aria-expanded={open}
      aria-controls={detailId}
      onClick={(event) => {
        // The whole row toggles too; don't let this click count twice.
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRight aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <Fragment>
      <tr className={open ? "is-open" : undefined} onClick={onToggle}>
        <td>
          {row.kind === "reader" ? (
            <>
              {toggle(row.label)}
              <small>{row.drops.length === 1 ? "Stopped reporting in" : `${row.drops.length} drop-outs`}</small>
            </>
          ) : (
            toggle(row.notice.summary)
          )}
        </td>
        <td>
          {row.kind === "reader" ? (
            <span className="notices-chip">
              <ShieldCheck aria-hidden="true" />
              Staff
            </span>
          ) : (
            <span className="notices-chip notices-chip--everyone">
              <Users aria-hidden="true" />
              {row.notice.recipients === null ? "Everyone" : people(row.notice.recipients, "person")}
            </span>
          )}
        </td>
        <td className="notices-num">
          {monthDay(first.openedAt, zone)}
          <small>{formatTime(first.openedAt, zone)}</small>
        </td>
        <td className="notices-num">
          {durationLabel(row.kind === "reader" ? totalDown(row.drops) : openFor(row.notice))}
          {row.kind === "reader" && row.drops.length > 1 ? <small>in total</small> : null}
        </td>
        <td>
          {row.kind === "reader" ? (
            <span className="status-pill status-pill--ok">Cleared itself</span>
          ) : (
            <>
              {row.notice.resolvedBy ?? "Staff"}
              {row.notice.resolution ? <small>“{row.notice.resolution}”</small> : null}
            </>
          )}
        </td>
      </tr>
      <tr className="notices-detail" id={detailId} hidden={!open}>
        <td colSpan={5}>
          {row.kind === "reader" ? (
            <ul className="notices-drops">
              {[...row.drops].reverse().map((drop) => (
                <li key={drop.id}>
                  <b>
                    {formatTime(drop.openedAt, zone)} – {formatTime(drop.resolvedAt!, zone)}
                  </b>
                  <span>{durationLabel(openFor(drop))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="notices-message">
                <b>Announced</b> “{row.notice.summary}”
                {row.notice.openedBy ? ` · sent by ${row.notice.openedBy}` : ""}
              </p>
              <p className="notices-message">
                <b>Fixed</b> {row.notice.resolution ? `“${row.notice.resolution}”` : "No message was recorded."}
                {row.notice.resolvedAt ? ` · ${monthDay(row.notice.resolvedAt, zone)}, ${formatTime(row.notice.resolvedAt, zone)}` : ""}
              </p>
            </>
          )}
        </td>
      </tr>
    </Fragment>
  );
}

/** Write, then see the email exactly as members will, then send. */
function ComposeDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (recipients: number | null) => void }) {
  const [step, setStep] = useState<"write" | "review">("write");
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const audience = useApi<{ recipients: number }>(open && step === "review" ? "/admin/service-notices/audience" : null);
  const close = () => {
    if (busy) return;
    setStep("write");
    setError("");
    onClose();
  };
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const sent = await api<{ recipients: number | null }>("/admin/service-notices", {
        method: "POST",
        body: { summary: summary.trim(), ...(note.trim() ? { reason: note.trim() } : {}) },
      });
      setSummary("");
      setNote("");
      setStep("write");
      onSent(sent?.recipients ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = summary.trim().length >= 5;
  return (
    <Modal
      open={open}
      title={step === "write" ? "Tell members about a problem" : "Email every member?"}
      width="compact"
      dismissible={!busy}
      onClose={close}
    >
      <div className="notices-dialog">
        <p className="notices-steps" aria-hidden="true">
          <span className={step === "write" ? "is-on" : undefined}>1 Write</span>
          <span className={step === "review" ? "is-on" : undefined}>2 Review</span>
        </p>
        {step === "write" ? (
          <form
            className="notices-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) setStep("review");
            }}
          >
            <label className="cw-field">
              <span>What members should know</span>
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={5} maxLength={500} rows={4} />
            </label>
            <label className="cw-field">
              <span>
                Note for the change log <small>(optional)</small>
              </span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
            </label>
            <div className="membership-dialog__actions">
              <button type="button" className="button button--quiet" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={!ready}>
                Review email
              </button>
            </div>
          </form>
        ) : (
          <>
            <EmailPreview
              status="Service issue"
              heading="A studio service issue needs your attention"
              intro="Some studio services aren’t working as expected right now."
              reason={summary.trim()}
            />
            <p className="notices-reach">
              <Users aria-hidden="true" />
              {audience.data
                ? `Goes to ${people(audience.data.recipients, "person")} who get notifications.`
                : audience.error
                  ? "Goes to every active account that gets notifications."
                  : "Counting who this reaches…"}
            </p>
            {error ? <p role="alert" className="form-error">{error}</p> : null}
            <div className="membership-dialog__actions">
              <button type="button" className="button button--quiet" disabled={busy} onClick={() => setStep("write")}>
                Keep editing
              </button>
              <button type="button" className="button button--primary" disabled={busy} onClick={() => void send()}>
                Send to everyone
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ResolveDialog({ notice, onClose, onSent }: { notice: ServiceNotice | null; onClose: () => void; onSent: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Each notice starts clean: no message or error carried over from another.
  useEffect(() => {
    setMessage("");
    setError("");
  }, [notice]);
  const send = async () => {
    if (!notice) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/service-notices/${notice.id}/resolve`, { method: "POST", body: { message: message.trim() } });
      onSent();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!notice} title="Tell everyone it's fixed?" width="compact" dismissible={!busy} onClose={() => !busy && onClose()}>
      <div className="notices-dialog">
        {notice ? <blockquote className="notices-quote">{notice.summary}</blockquote> : null}
        <label className="cw-field">
          <span>What was fixed</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={500} />
        </label>
        <p className="notices-reach">
          <Users aria-hidden="true" />
          Goes to every active account that gets notifications.
        </p>
        {error ? <p role="alert" className="form-error">{error}</p> : null}
        <div className="membership-dialog__actions">
          <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>
            Not yet
          </button>
          <button type="button" className="button button--primary" disabled={busy || !message.trim()} onClick={() => void send()}>
            Send to everyone
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The email as members receive it (see backend/src/notifications/templates.ts). */
function EmailPreview({ status, heading, intro, reason }: { status: string; heading: string; intro: string; reason: string }) {
  return (
    <figure className="notices-email" aria-label="Email preview">
      <div className="notices-email__top">
        <span>Service notice</span>
        <span className="notices-email__status">{status}</span>
      </div>
      <p className="notices-email__heading">{heading}</p>
      <p>{intro}</p>
      <dl>
        <dt>Reason</dt>
        <dd>{reason}</dd>
      </dl>
    </figure>
  );
}
