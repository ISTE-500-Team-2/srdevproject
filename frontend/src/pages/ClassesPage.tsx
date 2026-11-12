import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "../components/Management";
import { Toast } from "../components/Toast";
import { shortDate, timeOnly } from "../lib/display";
import type { Certification, SupervisionSummary } from "../lib/contracts";
import { ClassCatalog, type Eligibility } from "../components/classes/ClassCatalog";
import { ClassDetail } from "../components/classes/ClassDetail";
import { ClassSchedule } from "../components/classes/ClassSchedule";
import { RosterPanel } from "../components/classes/RosterPanel";
import { ScheduleClassDialog } from "../components/classes/ScheduleClassDialog";
import { CancelClassDialog } from "../components/classes/CancelClassDialog";
import {
  byStart,
  hasStarted,
  isCancelled,
  registrationPrice,
  type AttendanceDraft,
  type ClassRecord,
  type RosterPerson,
  type ScheduleSeed,
  type WorkshopTemplate,
} from "../components/classes/classData";
import "./classes.css";

const REFRESH_MS = 15000;
/** How far back to look for past classes whose attendance is still open. */
const ATTENDANCE_WINDOW_MS = 60 * 86400000;
const emptyDraft: AttendanceDraft = { statuses: {}, note: "" };
const hhmm = (value: string) => {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Counts roster entries still "registered" on past classes the user can see rosters for. */
function usePendingAttendance(candidates: ClassRecord[], refreshToken: number) {
  const [pending, setPending] = useState<Record<number, number>>({});
  const key = candidates.map((c) => c.id).join(",");
  useEffect(() => {
    if (!key) {
      setPending({});
      return;
    }
    let stale = false;
    void Promise.all(
      key.split(",").map(async (id) => {
        try {
          const roster = await api<RosterPerson[]>(`/classes/${id}/roster`);
          return [Number(id), roster.filter((p) => p.status === "enrolled").length] as const;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (!stale) setPending(Object.fromEntries(rows.filter((row) => row !== null)));
    });
    return () => {
      stale = true;
    };
  }, [key, refreshToken]);
  return pending;
}

export function ClassesPage() {
  const { user } = useAuth();
  const roles = user?.roles ?? [];
  const manager = roles.some((r) => r === "admin" || r === "staff");
  const admin = roles.includes("admin");
  const classes = useApi<ClassRecord[]>(user ? "/classes" : null, { retainOnReload: true });
  // Members see whether they can register before they try, using the same
  // entitlement check the enroll endpoint applies.
  const overview = useApi<{ entitlement: { membership: unknown; dayPass: unknown } }>(user && !manager ? "/me/overview" : null);
  const certifications = useApi<Certification[]>(user && !manager ? "/me/certifications" : null);
  // Members under 18 also need an active sponsoring adult linked, as enrollment checks.
  const supervision = useApi<SupervisionSummary>(user?.isMinor && !manager ? "/me/supervision" : null);
  // Staff pick workshops in the Schedule class dialog; members see unscheduled ones as cards.
  const workshops = useApi<WorkshopTemplate[]>(user && !manager ? "/classes/catalog" : null);

  const [refreshToken, setRefreshToken] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [rosterId, setRosterId] = useState<number | null>(null);
  const [cancelId, setCancelId] = useState<number | null>(null);
  const [scheduleSeed, setScheduleSeed] = useState<ScheduleSeed | null>(null);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [cancelReasons, setCancelReasons] = useState<Record<number, string>>({});
  const [drafts, setDrafts] = useState<Record<number, AttendanceDraft>>({});

  const all = useMemo(() => classes.data ?? [], [classes.data]);
  const find = (id: number | null) => (id === null ? undefined : all.find((c) => c.id === id));
  const canRecord = (c: ClassRecord) => admin || c.instructorId === user?.id;
  const teaching = useMemo(
    () =>
      manager
        ? []
        : all
            .filter(
              (c) =>
                c.instructorId === user?.id &&
                !isCancelled(c) &&
                new Date(c.startsAt).getTime() > Date.now() - ATTENDANCE_WINDOW_MS,
            )
            .sort(byStart),
    [all, manager, user?.id],
  );
  const attendanceCandidates = useMemo(
    () =>
      all.filter(
        (c) =>
          !isCancelled(c) &&
          hasStarted(c) &&
          new Date(c.startsAt).getTime() > Date.now() - ATTENDANCE_WINDOW_MS &&
          (manager || c.instructorId === user?.id),
      ),
    [all, manager, user?.id],
  );
  const pending = usePendingAttendance(attendanceCandidates, refreshToken);

  const hasUnsavedEdits =
    scheduleDirty ||
    Object.values(cancelReasons).some((reason) => reason.trim()) ||
    Object.values(drafts).some((d) => Object.keys(d.statuses).length > 0 || d.note.trim());

  const refreshAll = () => {
    classes.reload();
    certifications.reload();
    setRefreshToken((t) => t + 1);
  };
  // Restarting a request that is still running would abort it, so a slow list never finished.
  const classesBusy = useRef(false);
  classesBusy.current = classes.loading || classes.refreshing;
  useEffect(() => {
    const refresh = () => {
      if (!classesBusy.current && !hasUnsavedEdits && busyId === null && document.visibilityState !== "hidden") {
        classes.reload();
        setRefreshToken((t) => t + 1);
      }
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [classes.reload, hasUnsavedEdits, busyId]);

  async function act(c: ClassRecord, action: "enroll" | "withdraw") {
    setBusyId(c.id);
    setRowErrors(({ [c.id]: _, ...rest }) => rest);
    try {
      const price = registrationPrice(c, c.certificationId !== null && certified.has(c.certificationId));
      await api(`/classes/${c.id}/${action}`, { method: "POST", body: action === 'enroll'
        ? { expectedTrainingFeeCents: price.trainingFee } : {} });
      setToast(
        action === "enroll"
          ? `You're registered for ${c.title} on ${shortDate(c.startsAt)} at ${timeOnly(c.startsAt)}.`
          : `You withdrew from ${c.title}.`,
      );
      if (action === "withdraw") setDetailId(null);
    } catch (error) {
      setRowErrors((errors) => ({ ...errors, [c.id]: errorMessage(error) }));
    } finally {
      setBusyId(null);
      refreshAll();
    }
  }

  if (!user)
    return (
      <section>
        <h1 className="display-heading">Classes</h1>
        <p>Sign in to view scheduled instructor-led training and register.</p>
        <Link to="/login">Sign in</Link>
      </section>
    );

  const eligibility: Eligibility = !overview.data
    ? "unknown"
    : !overview.data.entitlement.membership && !overview.data.entitlement.dayPass
      ? "ineligible"
      : !user.isMinor
        ? "eligible"
        : !supervision.data
          ? "unknown"
          : supervision.data.sponsorEligible
            ? "eligible"
            : supervision.data.sponsor
              ? "sponsor-inactive"
              : "no-sponsor";
  const certified = new Set((certifications.data ?? []).filter((c) => c.valid).map((c) => c.id));
  const detail = find(detailId);
  const rosterClass = find(rosterId);
  const cancelClass = find(cancelId);

  return (
    <section className="classes-page page-enter">
      {classes.loading || classes.error ? <LoadState {...classes} /> : null}
      {classes.data ? (
        manager ? (
          <ClassSchedule
            classes={all}
            pending={pending}
            canRecord={canRecord}
            onSchedule={() => setScheduleSeed({})}
            onScheduleAgain={(c) =>
              setScheduleSeed({
                title: c.title,
                certificationId: c.certificationId ?? undefined,
                catalogId: c.catalogId ?? undefined,
                description: c.description,
                instructorId: c.instructorId,
                roomId: c.roomId,
                capacity: Math.min(c.capacity, 15),
                start: hhmm(c.startsAt),
                end: hhmm(c.endsAt),
              })
            }
            onCancel={(c) => setCancelId(c.id)}
            onRoster={(c) => setRosterId(c.id)}
          />
        ) : (
          <ClassCatalog
            classes={all}
            eligibility={eligibility}
            certified={certified}
            busyId={busyId}
            errors={rowErrors}
            teaching={teaching}
            workshops={workshops.data ?? []}
            onRegister={(c) => void act(c, "enroll")}
            onWithdraw={(c) => void act(c, "withdraw")}
            onDetails={(c) => setDetailId(c.id)}
            onRoster={(c) => setRosterId(c.id)}
          />
        )
      ) : null}

      {detail ? (
        <ClassDetail
          c={detail}
          workshops={workshops.data ?? []}
          eligibility={eligibility}
          certified={detail.certificationId !== null && certified.has(detail.certificationId)}
          busy={busyId === detail.id}
          error={rowErrors[detail.id]}
          refreshToken={refreshToken}
          onClose={() => setDetailId(null)}
          onRegister={(c) => void act(c, "enroll")}
          onWithdraw={(c) => void act(c, "withdraw")}
        />
      ) : null}
      {rosterClass ? (
        <RosterPanel
          key={rosterClass.id}
          c={rosterClass}
          canRecord={canRecord(rosterClass)}
          draft={drafts[rosterClass.id] ?? emptyDraft}
          refreshToken={refreshToken}
          onDraft={(draft) =>
            setDrafts(({ [rosterClass.id]: _, ...rest }) =>
              Object.keys(draft.statuses).length || draft.note ? { ...rest, [rosterClass.id]: draft } : rest,
            )
          }
          onSaved={refreshAll}
          onClose={() => setRosterId(null)}
        />
      ) : null}
      {scheduleSeed ? (
        <ScheduleClassDialog
          seed={scheduleSeed}
          onDirty={setScheduleDirty}
          onClose={() => {
            setScheduleSeed(null);
            setScheduleDirty(false);
          }}
          onPublished={(title) => {
            setScheduleSeed(null);
            setScheduleDirty(false);
            setToast(`${title} is on the schedule.`);
            refreshAll();
          }}
        />
      ) : null}
      {cancelClass ? (
        <CancelClassDialog
          c={cancelClass}
          reason={cancelReasons[cancelClass.id] ?? ""}
          onReason={(reason) => setCancelReasons((all) => ({ ...all, [cancelClass.id]: reason }))}
          onClose={() => setCancelId(null)}
          onStale={refreshAll}
          onCancelled={() => {
            setCancelReasons(({ [cancelClass.id]: _, ...rest }) => rest);
            setCancelId(null);
            setToast(`${cancelClass.title} is cancelled. Let the people who registered know.`);
            refreshAll();
          }}
        />
      ) : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}
