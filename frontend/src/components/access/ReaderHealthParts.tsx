// Pieces shared by the reader overview and the reader page: the 24-hour strip, the connection
// path, the door lights and the signal trend.

import { Cloud, Nfc, Server } from "lucide-react";
import { useState, type PointerEvent, type ReactNode } from "react";
import type { DoorState, ReaderHealthSummary, ReaderStatus } from "../../lib/nfc";
import { clock, duration, WEAK_SIGNAL_DBM } from "./readerHealthText";
import "./readerHealth.css";

type Day = ReaderHealthSummary["day"];

export function daySummary(day: Day) {
  if (!day.dropouts) return "No dropouts";
  return `${day.dropouts} ${day.dropouts === 1 ? "dropout" : "dropouts"} · ${duration(day.downMinutes * 60_000)}`;
}

const segmentWords = { ok: "working", degraded: "weak signal or recovering", down: "unreachable", unknown: "no report" };

export function HealthStrip({ day, timeZone, wide = false }: { day: Day; timeZone: string; wide?: boolean }) {
  const label = day.segments
    .map((segment) => `${segmentWords[segment.state]} ${clock(segment.start, timeZone)} to ${clock(segment.end, timeZone)}`)
    .join("; ");
  return (
    <div className={`health-strip${wide ? " health-strip--wide" : ""}`} role="img" aria-label={`Last 24 hours: ${label}`}>
      {day.segments.map((segment) => (
        <span
          key={segment.start}
          className={`health-strip__seg is-${segment.state}`}
          style={{ flexGrow: Date.parse(segment.end) - Date.parse(segment.start) }}
        />
      ))}
    </div>
  );
}

export function StripLegend() {
  return (
    <ul className="reader-legend" aria-label="Last 24 hours key">
      <li><span className="is-ok" aria-hidden="true" />Working</li>
      <li><span className="is-degraded" aria-hidden="true" />Weak signal or chip fault</li>
      <li><span className="is-down" aria-hidden="true" />Unreachable</li>
      <li><span className="is-unknown" aria-hidden="true" />No report</li>
    </ul>
  );
}

type Part = "ok" | "bad" | "unknown";
/** Which link in reader → gateway → Collaboratory a status points at. */
export function pathParts(status: ReaderStatus): { reader: Part; readerLink: Part; gateway: Part; cloudLink: Part } {
  switch (status) {
    case "working":
    case "weak_signal":
      return { reader: "ok", readerLink: "ok", gateway: "ok", cloudLink: "ok" };
    case "reader_fault":
      return { reader: "bad", readerLink: "ok", gateway: "ok", cloudLink: "ok" };
    case "online":
      return { reader: "unknown", readerLink: "unknown", gateway: "ok", cloudLink: "ok" };
    case "unreachable":
      return { reader: "bad", readerLink: "bad", gateway: "ok", cloudLink: "ok" };
    case "not_reporting":
      return { reader: "unknown", readerLink: "unknown", gateway: "bad", cloudLink: "bad" };
    default:
      return { reader: "unknown", readerLink: "unknown", gateway: "unknown", cloudLink: "unknown" };
  }
}
const partWords = { ok: "connected", bad: "broken", unknown: "unknown" };

export function ConnectionPath({ status }: { status: ReaderStatus }) {
  const p = pathParts(status);
  return (
    <span
      className="reader-path"
      role="img"
      aria-label={`Reader to gateway: ${partWords[p.readerLink]}. Gateway to Collaboratory: ${partWords[p.cloudLink]}.`}
    >
      <span className={`reader-path__node is-${p.reader}`}><Nfc aria-hidden="true" /></span>
      <span className={`reader-path__link is-${p.readerLink}`} />
      <span className={`reader-path__node is-${p.gateway}`}><Server aria-hidden="true" /></span>
      <span className={`reader-path__link is-${p.cloudLink}`} />
      <span className={`reader-path__node is-${p.cloudLink}`}><Cloud aria-hidden="true" /></span>
    </span>
  );
}

export function ConnectionPathWide({ reader, timeZone }: { reader: ReaderHealthSummary; timeZone: string }) {
  const p = pathParts(reader.status);
  const readerText =
    p.reader === "ok"
      ? "Ready"
      : reader.status === "reader_fault"
        ? "NFC chip not responding"
        : reader.status === "unreachable" && reader.since
          ? `No answer since ${clock(reader.since, timeZone)}`
          : "No report";
  const gatewayText =
    reader.status === "not_reporting" && reader.since
      ? `Last heard ${clock(reader.since, timeZone)}`
      : p.gateway === "ok"
        ? reader.status === "unreachable" ? "Online · retrying" : "Online"
        : "No report";
  const age = reader.health?.lastContactMs;
  const card = (part: Part, icon: ReactNode, title: string, text: string) => (
    <div className={`reader-path__card is-${part}`}>
      <span className={`reader-path__node is-${part}`}>{icon}</span>
      <strong>{title}</strong>
      <span className="reader-row__sub">{text}</span>
    </div>
  );
  const link = (part: Part, top: string, bottom: string) => (
    <div className={`reader-path__label${part === "bad" ? " is-bad" : ""}`}>
      <span>{top}</span>
      <span className={`reader-path__link is-${part}`} aria-hidden="true" />
      <span className="tabular">{bottom}</span>
    </div>
  );
  return (
    <div className="reader-path--wide">
      {card(p.reader, <Nfc aria-hidden="true" />, "Reader", readerText)}
      {link(
        p.readerLink,
        p.readerLink === "bad" ? "broken" : "link",
        p.readerLink === "bad" && reader.since
          ? duration(Date.now() - Date.parse(reader.since))
          : age != null ? `${(age / 1000).toFixed(1)} s ago` : "",
      )}
      {card(p.gateway, <Server aria-hidden="true" />, "Pi gateway", gatewayText)}
      {link(p.cloudLink, p.cloudLink === "bad" ? "broken" : "heartbeat", reader.lastSeenAt ? clock(reader.lastSeenAt, timeZone) : "")}
      {card(p.cloudLink, <Cloud aria-hidden="true" />, "Collaboratory", p.cloudLink === "ok" ? "Answering" : "No report")}
    </div>
  );
}

const doorWords: Record<DoorState, string> = {
  locked: "Locked",
  checking: "Checking a tap",
  approved: "Approved",
  denied: "Denied",
  issue: "Fault",
};
export function DoorLights({ state }: { state: DoorState | null }) {
  const red = state === "locked" || state === "checking" || state === "denied";
  return (
    <div className="reader-door">
      <div className={`reader-door__lights${state ? "" : " is-unknown"}`} aria-hidden="true">
        <span className={`is-red${red ? " is-on" : ""}`} />
        <span className={`is-yellow${state === "issue" ? " is-on" : ""}`} />
        <span className={`is-green${state === "approved" ? " is-on" : ""}`} />
      </div>
      <div>
        <strong>{state ? doorWords[state] : "Unknown"}</strong>
        <span className="reader-row__sub">
          {state === "locked" ? "Red, steady" : state === "checking" ? "Red, blinking" : state === "issue" ? "Yellow, blinking" : state ? "" : "Not reported"}
        </span>
      </div>
    </div>
  );
}

const W = 640, H = 150, LEFT = 40, RIGHT = 620, TOP = 10, BOTTOM = 120, MAX = -55, MIN = -95;
const y = (rssi: number) => TOP + ((MAX - Math.max(MIN, Math.min(MAX, rssi))) / (MAX - MIN)) * (BOTTOM - TOP);

/** Average signal per 15 minutes over the last day, with a hover readout. */
export function SignalTrend({ signal, timeZone }: { signal: { at: string; rssi: number | null }[]; timeZone: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const x = (index: number) => LEFT + (index / Math.max(1, signal.length - 1)) * (RIGHT - LEFT);
  const runs: string[] = [];
  let run: string[] = [];
  signal.forEach((point, index) => {
    if (point.rssi === null) {
      if (run.length) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(index).toFixed(1)},${y(point.rssi).toFixed(1)}`);
  });
  if (run.length) runs.push(run.join(" "));
  const known = signal.map((point, index) => ({ ...point, index })).filter((point) => point.rssi !== null);
  const last = known[known.length - 1];
  if (!last) return <p className="reader-row__sub">No signal reports in the last 24 hours.</p>;
  const lowest = Math.min(...known.map((point) => point.rssi as number));
  const shown = hover !== null ? signal[hover] : null;
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * W;
    const index = Math.round(((at - LEFT) / (RIGHT - LEFT)) * (signal.length - 1));
    setHover(index >= 0 && index < signal.length && signal[index]?.rssi !== null ? index : null);
  };
  const tipX = hover !== null ? Math.min(Math.max(x(hover) - 60, LEFT), RIGHT - 120) : 0;
  return (
    <figure className="reader-signal-chart">
      <figcaption>Wi-Fi signal</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Wi-Fi signal over the last 24 hours. Latest ${last.rssi} dBm at ${clock(last.at, timeZone)}; lowest ${lowest} dBm. Weak below ${WEAK_SIGNAL_DBM} dBm.`}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
      >
        <line className="reader-signal-chart__grid" x1={LEFT} x2={RIGHT} y1={y(-60)} y2={y(-60)} />
        <line className="reader-signal-chart__grid" x1={LEFT} x2={RIGHT} y1={y(-90)} y2={y(-90)} />
        <line className="reader-signal-chart__weak" x1={LEFT} x2={RIGHT} y1={y(WEAK_SIGNAL_DBM)} y2={y(WEAK_SIGNAL_DBM)} />
        <text className="reader-signal-chart__axis" x={LEFT - 6} y={y(-60) + 4} textAnchor="end">−60</text>
        <text className="reader-signal-chart__axis is-weak" x={LEFT - 6} y={y(WEAK_SIGNAL_DBM) + 4} textAnchor="end">−80</text>
        <text className="reader-signal-chart__axis" x={LEFT - 6} y={y(-90) + 4} textAnchor="end">−90</text>
        <text className="reader-signal-chart__axis is-weak" x={LEFT + 4} y={y(WEAK_SIGNAL_DBM) - 6}>Weak</text>
        <text className="reader-signal-chart__axis" x={LEFT} y={H - 4}>24 h ago</text>
        <text className="reader-signal-chart__axis" x={RIGHT} y={H - 4} textAnchor="end">Now</text>
        {runs.map((points) => (
          <polyline key={points} className="reader-signal-chart__line" points={points} />
        ))}
        <circle className="reader-signal-chart__dot" cx={x(last.index)} cy={y(last.rssi as number)} r={5} />
        {shown && hover !== null && shown.rssi !== null ? (
          <g>
            <line className="reader-signal-chart__cross" x1={x(hover)} x2={x(hover)} y1={TOP} y2={BOTTOM} />
            <g className="reader-signal-chart__tip" transform={`translate(${tipX} ${TOP})`}>
              <rect width="120" height="22" rx="5" />
              <text x="8" y="15">{`${clock(shown.at, timeZone)} · ${shown.rssi} dBm`}</text>
            </g>
          </g>
        ) : null}
      </svg>
    </figure>
  );
}
