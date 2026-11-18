// Reader overview: readers that need attention first, then every reader with its last day,
// connection path, last tap and signal, then the gateway that connects them.

import { Check, ChevronRight, CircleAlert, Server, TriangleAlert, Wifi, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import type { AccessReader, ReaderHealthBoard as Board, ReaderHealthSummary } from "../../lib/nfc";
import { ConnectionPath, daySummary, HealthStrip, StripLegend } from "./ReaderHealthParts";
import {
  attentionOrder,
  clock,
  duration,
  problemTitle,
  signalQuality,
  statusLabel,
  statusTone,
  tapResult,
} from "./readerHealthText";

const kindLabel = { building: "Building", room: "Room", equipment: "Equipment" };

export function readerLink(id: string) {
  return `?${new URLSearchParams({ view: "readers", reader: id })}`;
}

function StatusBadge({ reader }: { reader: ReaderHealthSummary }) {
  const tone = statusTone[reader.status];
  const since = reader.since ? ` · ${duration(Date.now() - Date.parse(reader.since))}` : "";
  return (
    <span className={`activity-badge is-${tone}`}>
      {tone === "allowed" ? <Check aria-hidden="true" /> : tone === "denied" ? <CircleAlert aria-hidden="true" /> : null}
      {statusLabel[reader.status]}
      {since}
    </span>
  );
}

function Signal({ reader }: { reader: ReaderHealthSummary }) {
  const rssi = reader.health?.rssi ?? null;
  if (reader.status === "unreachable")
    return (
      <span className="reader-signal is-lost">
        <WifiOff aria-hidden="true" />
        <span>Lost</span>
      </span>
    );
  const quality = signalQuality(rssi);
  if (!quality) return <span className="reader-row__sub">—</span>;
  return (
    <span className={`reader-signal is-${quality.toLowerCase()}`}>
      <Wifi aria-hidden="true" />
      <span className="reader-row__stack">
        <span>{quality}</span>
        <span className="reader-row__sub tabular">{rssi} dBm</span>
      </span>
    </span>
  );
}

function attentionDetail(reader: ReaderHealthSummary, timeZone: string) {
  const parts: string[] = [];
  if (reader.since) parts.push(`Since ${clock(reader.since, timeZone)}`);
  if (reader.status === "weak_signal" && reader.health?.rssi != null) parts.push(`${reader.health.rssi} dBm`);
  if (reader.day.dropouts) parts.push(`${daySummary(reader.day)} today`);
  return parts.join(" · ");
}

export function ReaderHealthBoard({
  board,
  readers,
  timeZone,
  stale,
}: {
  board: Board;
  readers: AccessReader[];
  timeZone: string;
  stale: boolean;
}) {
  const configured = new Map(readers.map((reader) => [reader.id, reader]));
  const shown = board.readers.filter((reader) => configured.has(reader.id));
  const attention = shown
    .filter((reader) => attentionOrder.includes(reader.status))
    .sort((a, b) => attentionOrder.indexOf(a.status) - attentionOrder.indexOf(b.status));
  const { gateway } = board;
  return (
    <>
      <p className={`reader-live${stale ? " is-stale" : ""}`} role="status">
        {stale ? "Reconnecting…" : `Live · updated ${clock(board.generatedAt, timeZone)}`}
      </p>
      {attention.length ? (
        <section className="reader-attention" aria-labelledby="reader-attention-title">
          <h3 id="reader-attention-title">Needs attention</h3>
          {attention.map((reader) => {
            const warning = statusTone[reader.status] === "pending";
            return (
              <Link key={reader.id} className={`reader-alert${warning ? " is-pending" : ""}`} to={readerLink(reader.id)}>
                <span className="reader-alert__icon">
                  {reader.status === "unreachable" ? <WifiOff aria-hidden="true" /> : warning ? <TriangleAlert aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
                </span>
                <div>
                  <h4>
                    {reader.name}: {problemTitle(reader)}
                  </h4>
                  <p>{attentionDetail(reader, timeZone)}</p>
                </div>
                <ChevronRight className="reader-alert__chevron" aria-hidden="true" />
              </Link>
            );
          })}
        </section>
      ) : null}
      {shown.length ? (
        <>
          <StripLegend />
          <div className="reader-table">
            <div className="reader-table__inner">
              <div className="reader-row reader-row--head" aria-hidden="true">
                <span>Reader</span>
                <span>Status</span>
                <span>Last 24 hours</span>
                <span>Connection</span>
                <span>Last tap</span>
                <span>Wi-Fi</span>
                <span />
              </div>
              {shown.map((reader) => {
                const setup = configured.get(reader.id)!;
                return (
                  <Link key={reader.id} className="reader-row" to={readerLink(reader.id)} aria-label={`${reader.name}: ${statusLabel[reader.status]}`}>
                    <span className="reader-row__name">
                      <strong>{reader.name}</strong>
                      <span className="reader-row__sub">
                        {setup.resourceName} · {kindLabel[setup.kind]}
                      </span>
                    </span>
                    <span>
                      <StatusBadge reader={reader} />
                    </span>
                    <span className="reader-row__stack">
                      <HealthStrip day={reader.day} timeZone={timeZone} />
                      <span className={`reader-row__sub${reader.day.dropouts ? " reader-summary-down" : ""}`}>{daySummary(reader.day)}</span>
                    </span>
                    <ConnectionPath status={reader.status} />
                    <span className="reader-row__stack">
                      {reader.lastTap ? (
                        <>
                          <span className="tabular">{clock(reader.lastTap.at, timeZone)}</span>
                          <span className="reader-row__sub">{tapResult(reader.lastTap)}</span>
                        </>
                      ) : (
                        <span className="reader-row__sub">No taps</span>
                      )}
                    </span>
                    <Signal reader={reader} />
                    <ChevronRight className="reader-row__chevron" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="reader-gateway">
            <span className="reader-gateway__icon">
              <Server aria-hidden="true" />
            </span>
            <span>
              <span className="reader-gateway__title">
                <strong>Pi gateway</strong>
                <span className={`activity-badge is-${gateway.reporting ? "allowed" : "denied"}`}>
                  {gateway.reporting ? "Reporting" : "Not reporting"}
                </span>
              </span>
              <p>
                {gateway.reachable} of {gateway.total} {gateway.total === 1 ? "reader" : "readers"} reachable
                {gateway.lastHeartbeatAt ? ` · last heartbeat ${clock(gateway.lastHeartbeatAt, timeZone)}` : ""}
              </p>
            </span>
          </div>
        </>
      ) : null}
    </>
  );
}
