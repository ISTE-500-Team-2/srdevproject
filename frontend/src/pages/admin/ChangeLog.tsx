import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronDown, Search, X } from "lucide-react";
import { LoadState } from "../../components/Management";
import { MemberSelect } from "../../components/MemberSelect";
import { AUDIT_AREAS, auditArea, areaLabel, type AuditArea } from "../../lib/auditActions";
import type { AuditPage, AuditView } from "../../lib/staffContracts";
import { addDays, dayKey, localHour } from "../../lib/today";
import { useApi } from "../../lib/useApi";
import { AuditFeed, ChangeLogPanel } from "./ChangeLogPanel";
import "./changeLog.css";

type Period = "today" | "7d" | "30d" | "all" | "custom";
const PERIODS: { id: Exclude<Period, "custom">; label: string; phrase: string }[] = [
  { id: "today", label: "Today", phrase: "today" },
  { id: "7d", label: "7 days", phrase: "in the last 7 days" },
  { id: "30d", label: "30 days", phrase: "in the last 30 days" },
  { id: "all", label: "All time", phrase: "in all" },
];
const VIEWS: { id: AuditView; label: string; one: string; many: string }[] = [
  { id: "staff", label: "Staff actions", one: "staff action", many: "staff actions" },
  { id: "taps", label: "Card taps", one: "card tap", many: "card taps" },
  { id: "database", label: "Database writes", one: "database write", many: "database writes" },
];
const PAGE = 50;

/** Facility-local midnight that starts a period, and the instant that ends it. */
function periodRange(period: Period, today: string, zone: string, custom: { from: string; to: string }) {
  const start = (day: string) => new Date(localHour(day, 0, zone)).toISOString();
  if (period === "today") return { from: start(today), to: "" };
  if (period === "7d") return { from: start(addDays(today, -6)), to: "" };
  if (period === "30d") return { from: start(addDays(today, -29)), to: "" };
  if (period === "custom")
    return {
      from: custom.from ? start(custom.from) : "",
      to: custom.to ? new Date(localHour(addDays(custom.to, 1), 0, zone) - 1).toISOString() : "",
    };
  return { from: "", to: "" };
}

/**
 * The change log: what staff did, with their reasons, apart from the card taps and the
 * database's own row-by-row record. Filters apply as they change, like Payments and
 * Reservations; picking a record opens it beside the list.
 */
export function ChangeLog() {
  const config = useApi<{ timeZone: string }>("/config", { reuse: true });
  const zone = config.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dayKey(Date.now(), zone);

  const [view, setView] = useState<AuditView>("staff");
  const [period, setPeriod] = useState<Period>("7d");
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [memberId, setMemberId] = useState("");
  const [actorId, setActorId] = useState("");
  const [areas, setAreas] = useState<AuditArea[]>([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Every action ever recorded, so an area can be turned into the actions it covers.
  const recorded = useApi<string[]>("/admin/audit/actions");
  const actions = areas.length ? recorded.data?.filter((action) => areas.includes(auditArea(action))) : null;
  const range = periodRange(period, today, zone, custom);
  const params = new URLSearchParams({ offset: String(offset), view });
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (memberId) params.set("userId", memberId);
  if (actorId) params.set("actorId", actorId);
  if (query) params.set("search", query);
  if (actions) params.set("actions", actions.join(","));
  // Wait for the action list before asking for an area; the server answers an empty list with nothing.
  const list = useApi<AuditPage>(areas.length && !recorded.data ? null : `/admin/audit?${params}`, { retainOnReload: true });

  const refilter = (change: () => void) => {
    change();
    setOffset(0);
  };
  const filtered = Boolean(query || memberId || actorId || areas.length);
  const clearFilters = () =>
    refilter(() => {
      setSearch("");
      setQuery("");
      setMemberId("");
      setActorId("");
      setAreas([]);
    });

  const page = list.data;
  const counts = page?.counts;
  const current = VIEWS.find((v) => v.id === view)!;
  const total = counts?.[view] ?? 0;
  const phrase =
    period === "custom"
      ? customPhrase(custom)
      : PERIODS.find((p) => p.id === period)!.phrase;

  const searchBox = useRef<HTMLInputElement>(null);
  // Opening a record moves focus into it, so closing it hands focus back to the row it came
  // from, or to the search box when the filters have since dropped that row.
  const closeRecord = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      const row = id ? document.querySelector<HTMLElement>(`.cl-row[data-id="${id}"]`) : null;
      (row ?? searchBox.current)?.focus();
    });
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selected) closeRecord();
  };

  return (
    <div className="today eq-workspace cl-page" onKeyDown={onKey}>
      <header className="eq-heading cl-heading">
        <div>
          <p className="eq-eyebrow">Records</p>
          <h1 className="admin-title">Change log</h1>
          <p className="cl-summary" aria-live="polite">
            {counts ? (
              <>
                <b>
                  {total} {total === 1 ? current.one : current.many}
                </b>{" "}
                {phrase}
                {filtered ? " match these filters" : ""}.
              </>
            ) : (
              "Who changed what in the shop, and why."
            )}
          </p>
        </div>
      </header>

      <div className="eq-toolbar cl-toolbar">
        <label className="eq-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search the change log</span>
          <input
            ref={searchBox}
            type="search"
            placeholder="Search people, equipment, plans or actions…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="eq-filters cl-views" role="group" aria-label="Show">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="eq-filter"
              aria-pressed={view === v.id}
              onClick={() => refilter(() => setView(v.id))}
            >
              <b className={counts && !counts[v.id] ? "is-zero" : undefined}>{counts ? counts[v.id].toLocaleString() : "–"}</b>{" "}
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cl-filters">
        <div className="eq-filters cl-period" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" className="eq-filter" aria-pressed={period === p.id} onClick={() => refilter(() => setPeriod(p.id))}>
              {p.label}
            </button>
          ))}
          <button type="button" className="eq-filter" aria-pressed={period === "custom"} onClick={() => refilter(() => setPeriod("custom"))}>
            <CalendarDays aria-hidden="true" /> Custom
          </button>
        </div>
        {period === "custom" ? (
          <div className="cl-range" role="group" aria-label="Custom dates">
            <label>
              From
              <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => refilter(() => setCustom((c) => ({ ...c, from: e.target.value })))} />
            </label>
            <label>
              Through
              <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => refilter(() => setCustom((c) => ({ ...c, to: e.target.value })))} />
            </label>
          </div>
        ) : null}
        <div className="cl-people">
          <MemberSelect label="Member" required={false} value={memberId} onChange={(id) => refilter(() => setMemberId(id))} />
          <MemberSelect label="Changed by" required={false} value={actorId} onChange={(id) => refilter(() => setActorId(id))} />
        </div>
        <AreaMenu areas={areas} onChange={(next) => refilter(() => setAreas(next))} />
        {filtered ? (
          <button type="button" className="cl-clear" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <div className={`cl-split${selected ? " cl-split--open" : ""}`}>
        <div className="cl-main">
          <LoadState loading={list.loading && !page} error={list.error || recorded.error} reload={list.error ? list.reload : recorded.reload} />
          {page ? (
            page.items.length ? (
              <>
                <AuditFeed items={page.items} zone={zone} today={today} selected={selected} onSelect={setSelected} />
                <div className="cl-foot">
                  <span>
                    Showing {offset + 1}–{offset + page.items.length} of {total.toLocaleString()}
                  </span>
                  {offset > 0 || page.nextOffset != null ? (
                    <span className="cl-foot__pages">
                      <button type="button" className="button button--quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                        Newer
                      </button>
                      <button type="button" className="button button--quiet" disabled={page.nextOffset == null} onClick={() => page.nextOffset != null && setOffset(page.nextOffset)}>
                        Older
                      </button>
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <EmptyState
                view={current}
                counts={counts}
                phrase={phrase}
                query={query}
                filtered={filtered}
                canWiden={period !== "all"}
                onView={(next) => refilter(() => setView(next))}
                onWiden={() => refilter(() => setPeriod(period === "today" || period === "7d" ? "30d" : "all"))}
                onClear={clearFilters}
              />
            )
          ) : null}
        </div>
        {selected ? <ChangeLogPanel id={selected} zone={zone} onSelect={setSelected} onClose={closeRecord} /> : null}
      </div>
    </div>
  );
}

function customPhrase(custom: { from: string; to: string }) {
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
  if (custom.from && custom.to) return `from ${day(custom.from)} through ${day(custom.to)}`;
  if (custom.from) return `since ${day(custom.from)}`;
  if (custom.to) return `through ${day(custom.to)}`;
  return "in all";
}

/** Areas group about sixty action codes into the parts of the shop people think in. */
function AreaMenu({ areas, onChange }: { areas: AuditArea[]; onChange: (areas: AuditArea[]) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const summary = !areas.length ? "All" : areas.length === 1 ? areaLabel(areas[0]) : `${areas.length} areas`;
  return (
    <details
      className="cl-areas"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current?.open) {
          event.stopPropagation();
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary className={`cl-chip${areas.length ? " is-set" : ""}`}>
        Area: <b>{summary}</b> <ChevronDown aria-hidden="true" />
      </summary>
      <fieldset className="cl-areas__menu">
        <legend className="sr-only">Show changes in these areas</legend>
        {AUDIT_AREAS.map((area) => (
          <label key={area.id} className="cl-areas__option">
            <input
              type="checkbox"
              checked={areas.includes(area.id)}
              onChange={(event) => onChange(event.target.checked ? [...areas, area.id] : areas.filter((a) => a !== area.id))}
            />
            {area.label}
          </label>
        ))}
        {areas.length ? (
          <button type="button" className="cl-clear" onClick={() => onChange([])}>
            All areas
          </button>
        ) : null}
      </fieldset>
    </details>
  );
}

function EmptyState({
  view,
  counts,
  phrase,
  query,
  filtered,
  canWiden,
  onView,
  onWiden,
  onClear,
}: {
  view: (typeof VIEWS)[number];
  counts?: Record<AuditView, number>;
  phrase: string;
  query: string;
  filtered: boolean;
  canWiden: boolean;
  onView: (view: AuditView) => void;
  onWiden: () => void;
  onClear: () => void;
}) {
  // Say what did match elsewhere, so an empty page is never a dead end.
  const elsewhere = VIEWS.filter((v) => v.id !== view.id && counts?.[v.id]);
  return (
    <div className="cl-empty">
      <p className="cl-empty__title">
        No {view.many}
        {query ? ` match “${query}”` : filtered ? " match these filters" : ""} {phrase}.
      </p>
      {elsewhere.length ? (
        <p>
          {elsewhere.map((v) => `${counts![v.id].toLocaleString()} ${counts![v.id] === 1 ? v.one : v.many}`).join(" and ")}{" "}
          {elsewhere.length === 1 && counts![elsewhere[0].id] === 1 ? "does" : "do"}.
        </p>
      ) : null}
      <div className="cl-empty__actions">
        {elsewhere.map((v) => (
          <button key={v.id} type="button" className="button button--quiet" onClick={() => onView(v.id)}>
            Show {v.many}
          </button>
        ))}
        {canWiden ? (
          <button type="button" className="button button--quiet" onClick={onWiden}>
            Look further back
          </button>
        ) : null}
        {filtered ? (
          <button type="button" className="button button--quiet" onClick={onClear}>
            <X aria-hidden="true" /> Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
