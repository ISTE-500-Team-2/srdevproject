// One reader: what is wrong and what to check, the connection path, its last day, recent activity,
// the lights at the door and what the reader reports about itself.

import {
  Check,
  ChevronLeft,
  CircleAlert,
  Cpu,
  Download,
  RefreshCw,
  RotateCw,
  Settings,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { AccessReader, ReaderActivity, ReaderHealthDetail } from "../../lib/nfc";
import { useApi } from "../../lib/useApi";
import { LoadState } from "../Management";
import { ConnectionPathWide, daySummary, DoorLights, HealthStrip, SignalTrend } from "./ReaderHealthParts";
import {
  activityLine,
  attentionOrder,
  clock,
  duration,
  problemTitle,
  signalQuality,
  statusLabel,
  statusTone,
  type Tone,
} from "./readerHealthText";

const kindLabel = { building: "Building entry", room: "Room", equipment: "Equipment" };

function when(value: string, timeZone: string) {
  const date = new Date(value);
  const today = new Date().toLocaleDateString([], { timeZone }) === date.toLocaleDateString([], { timeZone });
  return today ? clock(value, timeZone) : date.toLocaleDateString([], { timeZone, month: "short", day: "numeric" });
}

const activityLook: Record<ReaderActivity["type"], { tone: Tone; Icon: typeof Check }> = {
  tap: { tone: "allowed", Icon: Check },
  unreachable: { tone: "denied", Icon: WifiOff },
  reachable: { tone: "allowed", Icon: RefreshCw },
  address_changed: { tone: "neutral", Icon: RefreshCw },
  firmware_changed: { tone: "neutral", Icon: Download },
  restarted: { tone: "neutral", Icon: RotateCw },
  weak_signal: { tone: "pending", Icon: TriangleAlert },
  reader_fault: { tone: "denied", Icon: Cpu },
  reader_ready: { tone: "allowed", Icon: Cpu },
};

/** The signal change in the hour before `until`, when it fell noticeably. */
function signalDrop(detail: ReaderHealthDetail, until: string | null) {
  const end = until ? Date.parse(until) : Date.now();
  const hour = detail.signal.filter(
    (point) => point.rssi !== null && Date.parse(point.at) <= end && Date.parse(point.at) > end - 75 * 60_000,
  );
  const first = hour[0]?.rssi, last = hour[hour.length - 1]?.rssi;
  return first != null && last != null && first - last >= 5 ? { from: first, to: last } : null;
}

function Diagnosis({ detail, timeZone }: { detail: ReaderHealthDetail; timeZone: string }) {
  const drop = signalDrop(detail, detail.since);
  const sinceStart = detail.since ? Date.parse(detail.since) : null;
  const quietBefore =
    sinceStart !== null &&
    !detail.activity.some(
      (item) =>
        (item.type === "restarted" || item.type === "reader_fault") &&
        Date.parse(item.at) > sinceStart - 60 * 60_000 &&
        Date.parse(item.at) <= sinceStart,
    );
  const warning = statusTone[detail.status] === "pending";
  let known: string[] = [], done: string[] = [], steps: [string, string][] = [];
  switch (detail.status) {
    case "unreachable":
      known = [
        detail.since ? `Last check-in ${clock(detail.since, timeZone)}` : "No check-in",
        ...(drop ? [`Wi-Fi fell from ${drop.from} to ${drop.to} dBm in the hour before`] : []),
        "Gateway online",
        ...(quietBefore ? ["No restart or fault reported"] : []),
      ];
      done = ["Gateway retrying"];
      steps = [
        ["Yellow blinking", "no Wi-Fi. Move it closer to an access point."],
        ["All off", "no power. Check the USB cable."],
        ["Red, steady", "unplug power for 5 s."],
      ];
      break;
    case "not_reporting":
      known = [detail.since ? `Last heartbeat ${clock(detail.since, timeZone)}` : "No heartbeat"];
      steps = [
        ["Other readers also not reporting", "the Pi gateway is down. Check its power and network."],
        ["Only this reader", "restart the reader: unplug power for 5 s."],
      ];
      break;
    case "reader_fault":
      known = ["Reader online", "NFC chip not answering the reader"];
      done = ["Reader retrying the chip"];
      steps = [
        ["Restart the reader", "unplug power for 5 s."],
        ["Still failing", "check the cable to the NFC board."],
      ];
      break;
    case "weak_signal":
      known = [`Signal ${detail.health?.rssi ?? "—"} dBm`, ...(detail.day.dropouts ? [`${daySummary(detail.day)} today`] : [])];
      steps = [["Move it closer", "to an access point, or add a Wi-Fi extender."]];
      break;
  }
  return (
    <section className={`reader-card${warning ? "" : " reader-diagnosis"}`} aria-labelledby="reader-diagnosis-title">
      <div className="reader-diagnosis__head">
        <span className={`reader-alert__icon${warning ? " is-pending" : ""}`}>
          {detail.status === "unreachable" ? <WifiOff aria-hidden="true" /> : warning ? <TriangleAlert aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
        </span>
        <div>
          <h3 id="reader-diagnosis-title">{problemTitle(detail)}</h3>
          {detail.status === "unreachable" || detail.status === "not_reporting" || detail.status === "reader_fault" ? (
            <p>Members can't badge in.</p>
          ) : null}
        </div>
      </div>
      <div className="reader-diagnosis__columns">
        <div>
          <h4>What we know</h4>
          <ul>
            {known.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {done.length ? (
          <div>
            <h4>Already happening</h4>
            <ul>
              {done.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="reader-diagnosis__steps">
        <h4>{detail.status === "not_reporting" ? "To check" : "At the reader"}</h4>
        <ol>
          {steps.map(([label, text]) => (
            <li key={label}>
              <strong>{label}:</strong> {text}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ReaderDetail({
  id,
  reader,
  timeZone,
  onManage,
}: {
  id: string;
  reader: AccessReader | undefined;
  timeZone: string;
  onManage: (reader: AccessReader) => void;
}) {
  const result = useApi<ReaderHealthDetail>(`/admin/access/reader-health/${encodeURIComponent(id)}`, {
    refreshInterval: 5000,
    retainOnReload: true,
  });
  const detail = result.data;
  const back = (
    <Link className="reader-detail__back" to="?view=readers">
      <ChevronLeft aria-hidden="true" />
      Readers
    </Link>
  );
  if (detail && !reader)
    return (
      <div className="reader-detail">
        {back}
        <p className="empty-state">This reader is still being set up.</p>
      </div>
    );
  if (!detail || !reader)
    return (
      <div className="reader-detail">
        {back}
        <LoadState {...result} />
      </div>
    );
  const health = detail.health;
  const reachable = health?.reachable === true;
  const facts = reachable ? health : detail.lastKnown;
  const quality = signalQuality(facts?.rssi ?? null);
  const tone = statusTone[detail.status];
  return (
    <div className="reader-detail">
      {back}
      <header className="reader-detail__head">
        <div>
          <div className="reader-detail__title">
            <h2>{detail.name}</h2>
            <span className={`activity-badge is-${tone}`}>
              {tone === "allowed" ? <Check aria-hidden="true" /> : tone === "denied" ? <CircleAlert aria-hidden="true" /> : null}
              {statusLabel[detail.status]}
              {detail.since ? ` · ${duration(Date.now() - Date.parse(detail.since))}` : ""}
            </span>
          </div>
          <p className="reader-detail__meta">
            {reader.resourceName} · ID {reader.id}
          </p>
        </div>
        <div className="management-actions">
          <button type="button" className="button button--quiet" onClick={() => onManage(reader)}>
            <Settings aria-hidden="true" />
            Manage reader
          </button>
        </div>
      </header>

      {attentionOrder.includes(detail.status) ? <Diagnosis detail={detail} timeZone={timeZone} /> : null}

      <div className="reader-detail__columns">
        <div className="reader-detail__main">
          <section className="reader-card" aria-labelledby="reader-path-title">
            <div className="reader-card__head">
              <h3 id="reader-path-title">Connection</h3>
              <span className="reader-live">Live</span>
            </div>
            <ConnectionPathWide reader={detail} timeZone={timeZone} />
          </section>

          <section className="reader-card" aria-labelledby="reader-day-title">
            <div className="reader-card__head">
              <h3 id="reader-day-title">Last 24 hours</h3>
              <span className={`reader-row__sub${detail.day.dropouts ? " reader-summary-down" : ""}`}>{daySummary(detail.day)}</span>
            </div>
            <div>
              <HealthStrip day={detail.day} timeZone={timeZone} wide />
              <div className="health-strip__axis" aria-hidden="true">
                <span>24 h ago</span>
                <span>12 h ago</span>
                <span>Now</span>
              </div>
            </div>
            <SignalTrend signal={detail.signal} timeZone={timeZone} />
          </section>

          <section className="reader-card" aria-labelledby="reader-activity-title">
            <h3 id="reader-activity-title">Activity</h3>
            {detail.activity.length ? (
              <ol className="reader-activity">
                {detail.activity.map((item) => {
                  const look = activityLook[item.type];
                  const tapTone = item.type === "tap" ? (item.detail.allowed ? "allowed" : "denied") : look.tone;
                  const Icon = item.type === "tap" && !item.detail.allowed ? X : look.Icon;
                  const line = activityLine(item);
                  return (
                    <li key={`${item.type}-${item.at}`}>
                      <time dateTime={item.at}>{when(item.at, timeZone)}</time>
                      <span className={`reader-activity__dot is-${tapTone}`}>
                        <Icon aria-hidden="true" />
                      </span>
                      <span className="reader-activity__text">
                        <strong>{line.title}</strong>
                        {line.detail ? <span>{line.detail}</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="reader-row__sub">No activity yet.</p>
            )}
          </section>
        </div>

        <div className="reader-detail__side">
          <section className="reader-card" aria-labelledby="reader-door-title">
            <h3 id="reader-door-title">At the door</h3>
            <DoorLights state={reachable ? (health?.doorState ?? null) : null} />
          </section>

          <section className="reader-card" aria-labelledby="reader-device-title">
            <div className="reader-card__head">
              <h3 id="reader-device-title">Device</h3>
              {!reachable && detail.lastKnown ? (
                <span className="reader-row__sub">as of {clock(detail.lastKnown.at, timeZone)}</span>
              ) : null}
            </div>
            <dl className="reader-facts">
              <dt>Firmware</dt>
              <dd>{facts?.firmware ?? "—"}</dd>
              <dt>NFC chip</dt>
              <dd>{facts?.ready == null ? "—" : facts.ready ? "Responding" : "Not responding"}</dd>
              <dt>Wi-Fi signal</dt>
              <dd className={`tabular${quality === "Weak" ? " is-weak" : ""}`}>
                {facts?.rssi != null ? `${facts.rssi} dBm · ${quality?.toLowerCase()}` : "—"}
              </dd>
              <dt>Network address</dt>
              <dd className="tabular">{facts?.address ?? "—"}</dd>
              {reachable && health?.uptimeMs != null ? (
                <>
                  <dt>Running for</dt>
                  <dd>{duration(health.uptimeMs)}</dd>
                </>
              ) : null}
              <dt>Last report</dt>
              <dd className="tabular">{detail.lastReport ? clock(detail.lastReport, timeZone) : "—"}</dd>
            </dl>
          </section>

          <section className="reader-card" aria-labelledby="reader-settings-title">
            <h3 id="reader-settings-title">Settings</h3>
            <dl className="reader-facts">
              <dt>Location</dt>
              <dd>{reader.resourceName}</dd>
              <dt>Access</dt>
              <dd>{kindLabel[reader.kind]}</dd>
              <dt>Reader</dt>
              <dd>{reader.enabled ? "Enabled" : "Disabled"}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
