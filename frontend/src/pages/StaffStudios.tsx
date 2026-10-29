import { useEffect, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { AccountPicker } from "../components/admin/AccountPicker";
import { LoadState } from "../components/Management";
import { DeskQueue } from "../components/studios/DeskQueue";
import { OccupancyBoard } from "../components/studios/OccupancyBoard";
import { StudioSheet } from "../components/studios/StudioSheet";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import type { Rental, Studio } from "../lib/studioContracts";
import { deskTasks, studioSummary } from "../lib/studioDesk";
import { dayKey } from "../lib/today";
import { useApi } from "../lib/useApi";
import "./studios.css";

// Holds and payments arrive from members and card checkout while staff watch
// this page, so it stays current without a manual refresh.
const live = { retainOnReload: true, refreshInterval: 15000 };

/** Staff Studios page: what needs recording, who's in which studio, and each studio's terms. */
export function StaffStudios() {
  const { user } = useAuth();
  const admin = !!user?.roles.some((r) => ["admin", "super-admin"].includes(r));
  const config = useApi<{ timeZone: string }>("/config", { retainOnReload: true });
  const studios = useApi<{ studios: Studio[] }>("/studios", live);
  const rentals = useApi<Rental[]>("/studio-management/rentals", live);
  const [now, setNow] = useState(Date.now);
  const [tab, setTab] = useState<"needs" | "studios">("needs");
  const [openId, setOpenId] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const timeZone = config.data?.timeZone;
  const list = studios.data?.studios;
  const records = rentals.data;
  const waiting = [config, studios, rentals].find((r) => !r.data);
  if (!timeZone || !list || !records)
    return (
      <section className="studio-desk" aria-labelledby="studio-desk-title">
        <h1 id="studio-desk-title" className="admin-title">Studios</h1>
        {waiting ? <LoadState loading={waiting.loading} error={waiting.error} reload={waiting.reload} /> : null}
      </section>
    );

  const today = dayKey(now, timeZone);
  const tasks = deskTasks(records);
  const summary = studioSummary(list, today);
  const open = list.find((s) => s.id === openId);
  const refresh = () => {
    rentals.reload();
    studios.reload();
  };

  return (
    <section className="studio-desk" aria-labelledby="studio-desk-title">
      <div className="studio-desk__head">
        <div>
          <h1 id="studio-desk-title" className="admin-title">Studios</h1>
          <p className="studio-desk__summary">
            <span><i className="desk-dot desk-dot--rented" />{summary.rented} rented now</span>
            <span><i className="desk-dot desk-dot--open" />{summary.open} open now</span>
            {summary.held ? <span><i className="desk-dot desk-dot--held" />{summary.held} held for payment</span> : null}
            {summary.off ? <span><i className="desk-dot desk-dot--off" />{summary.off} not offered</span> : null}
          </p>
        </div>
        <button type="button" className="button button--quiet studio-desk__book" onClick={() => setPicker(true)}>
          <CalendarPlus aria-hidden="true" />
          Book for a member
        </button>
      </div>
      {message ? (
        <p className="studio-message" role="status">
          {message}
        </p>
      ) : null}
      <div className="desk-tabs" role="group" aria-label="Show">
        <button type="button" aria-pressed={tab === "needs"} onClick={() => setTab("needs")}>
          Needs you <em className={tasks.length ? "desk-tabs__hot" : undefined}>{tasks.length}</em>
        </button>
        <button type="button" aria-pressed={tab === "studios"} onClick={() => setTab("studios")}>
          Studios <em>{list.length}</em>
        </button>
      </div>
      <div className={`studio-desk__body studio-desk__body--${tab}`}>
        <DeskQueue
          tasks={tasks}
          timeZone={timeZone}
          now={now}
          perform={async (path, body, done) => {
            setMessage("");
            await api(path, { method: "POST", body });
            setMessage(done);
            refresh();
          }}
        />
        <OccupancyBoard studios={list} rentals={records} today={today} timeZone={timeZone} canEdit={admin} onOpen={setOpenId} />
      </div>
      {open ? (
        <StudioSheet
          studio={open}
          rentals={records}
          today={today}
          timeZone={timeZone}
          canEdit={admin}
          onClose={() => setOpenId(null)}
          save={async (body) => {
            await api(`/studio-management/studios/${open.id}`, { method: "PATCH", body });
            setMessage(`${open.name} saved. Existing rentals keep the terms they booked with.`);
            refresh();
          }}
        />
      ) : null}
      {picker ? <AccountPicker destination="/studios" onClose={() => setPicker(false)} /> : null}
    </section>
  );
}
