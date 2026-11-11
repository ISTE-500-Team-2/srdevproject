import { accessReasonLabel } from "../../../lib/accessReadiness";
import type { SupervisionSummary } from "../../../lib/contracts";
import { dollars, shortDate, timeOnly } from "../../../lib/display";
import type { Audit, Entitlement, MemberRequirements, Payment, Person } from "../../../lib/staffContracts";

/**
 * The member record's reading of the data: is this person cleared for the shop,
 * what needs a staff member, and what happened lately. Pure, so it is tested
 * without rendering.
 */

export type Tone = "ok" | "bad" | "in" | "info";
export type ReqState = "ok" | "warn" | "bad";
export type VerdictIcon = "shield" | "pause" | "ban" | "login" | "info" | "alert";

export interface Verdict {
  tone: Tone;
  icon: VerdictIcon;
  title: string;
  detail: string;
  /** Quoted staff reason, shown in its own type. */
  quote?: string;
}
export interface Requirement {
  key: "account" | "membership" | "waiver" | "training" | "card" | "sponsor";
  label: string;
  state: ReqState;
  value: string;
  /** Spelled out for assistive tech and the tile's tooltip. */
  description: string;
}
export interface ActivityRow {
  id: string;
  type: "visit" | "tap" | "change";
  tone: "ok" | "alert" | "neutral";
  icon: "login" | "logout" | "x" | "check" | "nfc" | "receipt" | "pause" | "user" | "shield" | "pen";
  title: string;
  detail: string;
  at: string;
}
export interface NeedItem {
  id: string;
  alert: boolean;
  icon: "cap" | "waiver" | "pause" | "calendar" | "receipt" | "user" | "x";
  title: string;
  detail: string;
  action:
    | { kind: "link"; label: string; href: string }
    | { kind: "sell"; label: string }
    | { kind: "entitlement"; label: string; item: Entitlement }
    | { kind: "payment"; label: string; payment: Payment }
    | { kind: "sponsor"; label: string }
    | { kind: "renew"; label: string; item: Entitlement };
}

const DAY = 86_400_000;
export const firstName = (p: Pick<Person, "firstName">) => p.firstName;
const list = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** Whole calendar days from today to `at`: a membership ending Nov 14 is "4 days" away on Nov 10. */
export function daysUntil(at: string, now = new Date()) {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(new Date(at)) - start(now)) / DAY);
}
export function dayLabel(at: string, now = new Date()) {
  const d = new Date(at);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(now.getTime() - DAY))) return "Yesterday";
  return shortDate(d, d.getFullYear() !== now.getFullYear());
}
const when = (at: string, now = new Date()) => {
  const label = dayLabel(at, now);
  return label === "Today" ? `today at ${timeOnly(at)}` : label === "Yesterday" ? `yesterday at ${timeOnly(at)}` : label;
};

/** The latest change-log entry for an action, for "set by … on …". */
export function latest(audit: Audit[], test: (a: Audit) => boolean) {
  return audit.find(test) ?? null;
}

export function accountWords(status: string) {
  return status === "active" ? "Active" : status === "suspended" ? "On hold" : status === "inactive" ? "Closed" : status;
}
export function accessWords(status: string) {
  return status === "active" ? "No restriction" : status === "suspended" ? "Suspended" : status === "revoked" ? "Revoked" : status;
}
const ROLE_NAMES: Record<string, string> = {
  member: "Community member",
  subscriber: "Subscriber",
  day_pass: "Day-pass customer",
  instructor: "Instructor",
  staff: "Staff",
  admin: "Administrator",
};
export const roleName = (role: string) => ROLE_NAMES[role] ?? role;
export const ROLES = Object.keys(ROLE_NAMES);

export function verdict(input: {
  person: Person;
  req: MemberRequirements | null;
  supervision: SupervisionSummary | null;
  audit: Audit[];
  now?: Date;
}): Verdict {
  const { person: p, req, supervision, audit } = input;
  const now = input.now ?? new Date();
  const visit = supervision?.visit ?? req?.visit ?? null;
  const by = (prefix: string) => {
    const entry = latest(audit, (a) => a.action.startsWith(prefix));
    return entry ? ` Set by ${entry.actorName} ${when(entry.createdAt, now)}.` : "";
  };
  if (p.status !== "active")
    return {
      tone: "bad",
      icon: p.status === "suspended" ? "pause" : "ban",
      title: p.status === "suspended" ? "On hold: can’t sign in or check in" : "Account closed: can’t sign in or check in",
      quote: p.accountReason || undefined,
      detail: by("user.account_").trim() || "Bookings and history are kept.",
    };
  if (p.accessStatus !== "active")
    return {
      tone: "bad",
      icon: "ban",
      title: p.accessStatus === "revoked" ? "Facility access revoked" : "Facility access suspended",
      quote: p.accessReason || undefined,
      detail: `${firstName(p)} can still sign in, but readers, check-in and new bookings refuse them.${by("user.access_")}`,
    };
  if (visit) {
    const since = `In the building since ${timeOnly(visit.checkedInAt)}`;
    const minor = req?.minor;
    return {
      tone: "in",
      icon: "login",
      title: since,
      detail: minor?.sponsorName
        ? `With ${minor.sponsorName}, their sponsoring adult. Checking ${minor.sponsorName.split(" ")[0]} out ends ${firstName(p)}’s visit too.`
        : `${visit.buildingName ?? "Checked in"}. Card taps work on machines ${firstName(p)} is trained for.`,
    };
  }
  if (!req)
    return { tone: "info", icon: "info", title: "Checking requirements…", detail: "Membership, waivers and training load in a moment." };
  if (!req.entitlement)
    return {
      tone: "bad",
      icon: "alert",
      title: "No membership or day pass",
      detail: `${firstName(p)} needs one before checking in. Sell one below or record a payment taken at the desk.`,
    };
  if (req.waivers.required === 0)
    return {
      tone: "bad",
      icon: "alert",
      title: "No facility waiver is set up",
      detail: "Nobody can check in until an administrator publishes the required policies.",
    };
  if (req.waivers.signed < req.waivers.required)
    return {
      tone: "bad",
      icon: "alert",
      title: "Waiver not signed",
      detail: `${firstName(p)} has to sign ${list(req.waivers.missing)} before checking in.`,
    };
  if (req.minor && !req.minor.sponsorName)
    return {
      tone: "bad",
      icon: "alert",
      title: "Needs a sponsoring adult",
      detail: `${firstName(p)} is under 18. Link an adult who agrees to supervise them before they check in.`,
    };
  if (req.minor && !req.minor.sponsorHere)
    return {
      tone: "bad",
      icon: "alert",
      title: `Waiting for ${req.minor.sponsorName}`,
      detail: `${firstName(p)} is under 18. ${req.minor.sponsorName} has to be checked in first, with their own access.`,
    };
  const lastVisit = latest(audit, (a) => a.action === "visit.check-in" || a.entityType === "check_in");
  const away = lastVisit ? `Not in the building; last visit ${when(lastVisit.createdAt, now)}.` : "Not in the building.";
  return {
    tone: "ok",
    icon: "shield",
    title: "Cleared for the shop",
    detail: req.training.missing.length
      ? `Except ${list(req.training.missing)}, which ${req.training.missing.length === 1 ? "needs" : "need"} training. ${away}`
      : away,
  };
}

export function requirements(p: Person, req: MemberRequirements | null): Requirement[] {
  if (!req) return [];
  const rows: Requirement[] = [];
  const accountOk = p.status === "active" && p.accessStatus === "active";
  const account = p.status !== "active" ? accountWords(p.status) : p.accessStatus !== "active" ? `Access ${accessWords(p.accessStatus).toLowerCase()}` : "Active";
  rows.push({ key: "account", label: "Account", state: accountOk ? "ok" : "bad", value: account, description: `Account: ${account}` });
  const e = req.entitlement;
  const ent = e ? (e.kind === "membership" ? `${e.name} to ${shortDate(e.endsAt).replace(/^\w+, /, "")}` : `${e.name} today`) : "None active";
  rows.push({ key: "membership", label: e?.kind === "day_pass" ? "Day pass" : "Membership", state: e ? "ok" : "bad", value: ent, description: `Membership or pass: ${ent}` });
  const w = req.waivers;
  const waiver =
    w.required === 0 ? "None set up" : w.signed === w.required ? (w.lastSignedAt ? `Signed ${shortDate(w.lastSignedAt).replace(/^\w+, /, "")}` : "Signed") : `${w.required - w.signed} to sign`;
  rows.push({ key: "waiver", label: "Waiver", state: w.required > 0 && w.signed === w.required ? "ok" : "bad", value: waiver, description: `Waiver: ${waiver}${w.missing.length ? ` (${w.missing.join(", ")})` : ""}` });
  const t = req.training;
  const training =
    t.required === 0 ? "None needed" : t.held === t.required ? `All ${t.required} machines` : t.missing.length === 1 ? `Not on ${t.missing[0]}` : `${t.held} of ${t.required} machines`;
  rows.push({ key: "training", label: "Training", state: t.held === t.required ? "ok" : "warn", value: training, description: `Training: ${training}${t.missing.length ? `. Missing: ${t.missing.join(", ")}` : ""}` });
  if (req.minor) {
    const s = req.minor;
    const sponsor = !s.sponsorName ? "Not linked" : s.sponsorHere ? `${s.sponsorName.split(" ")[0]} is here` : `${s.sponsorName.split(" ")[0]} isn’t here`;
    rows.push({ key: "sponsor", label: "Sponsor", state: !s.sponsorName ? "bad" : s.sponsorHere ? "ok" : "warn", value: sponsor, description: `Sponsoring adult: ${sponsor}` });
  }
  const cards = req.cards.active;
  const card = cards === 0 ? "No card yet" : cards === 1 ? "1 active" : `${cards} active`;
  rows.push({ key: "card", label: "NFC card", state: cards ? "ok" : "warn", value: card, description: `NFC cards: ${card}` });
  return rows;
}

/** Raw database echoes the change log keeps for audits; the record shows people's actions. */
const isNoise = (a: Audit) =>
  /\.(insert|update|delete)$/.test(a.action) && !["app_device_access_event", "check_in"].includes(a.entityType);
const CHANGE_TITLES: Record<string, [string, ActivityRow["icon"], ActivityRow["tone"]?]> = {
  "user.account_suspended": ["Account put on hold", "pause", "alert"],
  "user.account_inactive": ["Account closed", "x", "alert"],
  "user.account_active": ["Account reactivated", "check", "ok"],
  "user.access_suspended": ["Facility access suspended", "pause", "alert"],
  "user.access_revoked": ["Facility access revoked", "x", "alert"],
  "user.access_active": ["Facility access restored", "check", "ok"],
  "user.profile_updated": ["Name or phone updated", "pen"],
  "user.role_changed": ["Roles changed", "user"],
  "user.conduct_flagged": ["Conduct flag turned on", "shield", "alert"],
  "user.conduct_cleared": ["Conduct flag cleared", "shield"],
  "access.card_assigned": ["NFC card assigned", "nfc"],
  "access.card_revoked": ["NFC card revoked", "nfc"],
  "access.card_reactivated": ["NFC card reactivated", "nfc"],
  "access.override_created": ["Supervised use started", "shield"],
  "access.override_revoked": ["Supervised use ended", "shield"],
  "access.issued": ["Membership or pass issued", "receipt"],
  "minor.sponsor_linked": ["Sponsoring adult linked", "user"],
  "minor.sponsor_unlinked": ["Sponsoring adult removed", "user"],
  "payment.recorded": ["Payment recorded", "receipt"],
};
export function activity(audit: Audit[]): ActivityRow[] {
  return audit.filter((a) => !isNoise(a)).map((a): ActivityRow => {
    const reason = a.reason && a.reason !== "Database change" ? a.reason : "";
    const by = a.actorName && a.actorName !== "System" ? `by ${a.actorName}` : "";
    if (a.entityType === "app_device_access_event") {
      const place = a.resourceName ? ` at ${a.resourceName}` : "";
      return {
        id: a.id,
        type: "tap",
        tone: a.allowed === false ? "alert" : a.allowed ? "ok" : "neutral",
        icon: a.allowed === false ? "x" : "nfc",
        title: a.allowed === false ? `Card tap denied${place}` : a.allowed ? `Card tap allowed${place}` : `Card scanned${place}`,
        detail: a.accessReason && a.allowed === false ? accessReasonLabel(a.accessReason) : a.readerId ? `Reader ${a.readerId}` : "Reader",
        at: a.createdAt,
      };
    }
    if (a.action === "visit.check-in" || a.action === "visit.check-out" || a.entityType === "check_in") {
      const out = a.action === "visit.check-out";
      return {
        id: a.id,
        type: "visit",
        tone: out ? "neutral" : "ok",
        icon: out ? "logout" : "login",
        title: out ? "Checked out" : a.entityType === "check_in" ? "Checked in at a reader" : "Checked in",
        detail: [a.resourceName, by].filter(Boolean).join(" · ") || "Front desk",
        at: a.createdAt,
      };
    }
    const known = CHANGE_TITLES[a.action];
    const status = /^(entitlement|payment)\.(\w+)/.exec(a.action);
    const title = known?.[0] ?? (status ? `${status[1] === "payment" ? "Payment" : "Membership or pass"} set to ${status[2]!.replaceAll("_", " ")}` : a.action.replace(/^app_/, "").replaceAll(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
    return {
      id: a.id,
      type: "change",
      tone: known?.[2] ?? "neutral",
      icon: known?.[1] ?? "pen",
      title,
      detail: [reason ? `“${reason}”` : "", by].filter(Boolean).join(" · "),
      at: a.createdAt,
    };
  });
}

/** Group rows under Today / Yesterday / a date, newest first. */
export function byDay(rows: ActivityRow[], now = new Date()) {
  const groups: { day: string; rows: ActivityRow[] }[] = [];
  for (const row of rows) {
    const day = dayLabel(row.at, now);
    const last = groups.at(-1);
    if (last?.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

/** The current membership or pass, and everything else, newest first. */
export function plans(memberships: Entitlement[], passes: Entitlement[]) {
  const live = (e: Entitlement) => ["active", "scheduled", "suspended"].includes(e.effectiveStatus);
  const current = memberships.find((m) => m.effectiveStatus === "active") ?? passes.find((p) => p.effectiveStatus === "active") ?? memberships.find(live) ?? passes.find(live) ?? null;
  const earlier = [
    ...memberships.map((item) => ({ item, kind: "membership" as const })),
    ...passes.map((item) => ({ item, kind: "day_pass" as const })),
  ]
    .filter(({ item }) => item !== current)
    .sort((a, b) => (b.item.startsAt ?? b.item.validDate ?? "").localeCompare(a.item.startsAt ?? a.item.validDate ?? ""));
  return { current, currentKind: current ? (memberships.includes(current) ? ("membership" as const) : ("day_pass" as const)) : null, earlier };
}

export function needs(input: {
  person: Person;
  req: MemberRequirements | null;
  audit: Audit[];
  memberships: Entitlement[];
  payments: Payment[];
  canManage: boolean;
  now?: Date;
}): NeedItem[] {
  const { person: p, req, audit, memberships, payments, canManage } = input;
  const now = input.now ?? new Date();
  const items: NeedItem[] = [];
  const name = firstName(p);
  const denied = audit.find((a) => a.entityType === "app_device_access_event" && a.allowed === false && now.getTime() - Date.parse(a.createdAt) < DAY);
  if (denied && p.status === "active" && p.accessStatus === "active") {
    const reason = denied.accessReason ?? "";
    const place = denied.resourceName ?? "a reader";
    const training = reason === "CERTIFICATION_REQUIRED";
    items.push({
      id: `denied-${denied.id}`,
      alert: true,
      icon: training ? "cap" : "x",
      title: `Denied at ${place} ${dayLabel(denied.createdAt, now) === "Today" ? "today" : "yesterday"}`,
      detail: `${name} tapped at ${timeOnly(denied.createdAt)}. ${reason ? accessReasonLabel(reason) : ""}`.trim(),
      action: training
        ? { kind: "link", label: "Open training", href: "/admin/certifications?section=certifications" }
        : reason === "ENTITLEMENT_REQUIRED"
          ? { kind: "sell", label: "Sell a membership" }
          : reason === "WAIVER_REQUIRED"
            ? { kind: "link", label: "Review waivers", href: "/admin/certifications?section=compliance" }
            : { kind: "link", label: "Open reader access", href: "/admin/access" },
    });
  }
  const live = memberships.find((m) => m.effectiveStatus === "active");
  if (p.status === "suspended" && live && canManage) {
    const since = latest(audit, (a) => a.action === "user.account_suspended");
    const days = since ? Math.max(1, Math.floor((now.getTime() - Date.parse(since.createdAt)) / DAY)) : null;
    items.push({
      id: "hold",
      alert: true,
      icon: "pause",
      title: days ? `On hold for ${days} ${days === 1 ? "day" : "days"}` : "On hold",
      detail: live.cardBilled
        ? `${name}’s card membership keeps billing during the hold. Suspending membership access does not pause or cancel card billing.`
        : `${name}’s membership keeps running during the hold. Suspending access does not extend its end date.`,
      action: { kind: "entitlement", label: "Suspend membership access", item: live },
    });
  }
  if (req?.waivers.missing.length && p.status === "active")
    items.push({
      id: "waiver",
      alert: true,
      icon: "waiver",
      title: req.waivers.missing.length === 1 ? "A waiver needs signing" : `${req.waivers.missing.length} waivers need signing`,
      detail: `${list(req.waivers.missing)}. ${name} signs from their own account, or you can open it for them.`,
      action: { kind: "link", label: "Review waivers", href: "/admin/certifications?section=compliance" },
    });
  if (req?.minor && !req.minor.sponsorName && canManage)
    items.push({
      id: "sponsor",
      alert: true,
      icon: "user",
      title: "No sponsoring adult",
      detail: `${name} is under 18 and can’t check in until an adult agrees to supervise them.`,
      action: { kind: "sponsor", label: "Link an adult" },
    });
  if (live?.endsAt && !live.cardBilled && canManage) {
    const days = daysUntil(live.endsAt, now);
    if (days >= 0 && days <= 7)
      items.push({
        id: "ending",
        alert: false,
        icon: "calendar",
        title: days === 0 ? "Membership ends today" : `Membership ends in ${days} ${days === 1 ? "day" : "days"}`,
        detail: `It doesn’t renew by itself. Renew it here if ${name} pays at the desk.`,
        action: { kind: "renew", label: "Renew", item: live },
      });
  }
  for (const pay of payments.filter((x) => x.status === "pending").slice(0, 2))
    if (canManage)
      items.push({
        id: `pay-${pay.id}`,
        alert: false,
        icon: "receipt",
        title: `${dollars(pay.amount)} payment pending`,
        detail: `${pay.planName || "Payment"} #${pay.id}, recorded ${shortDate(pay.recordedAt)}. Mark it paid, waived or void once settled.`,
        action: { kind: "payment", label: "Update payment", payment: pay },
      });
  return items;
}

/** Plain digits read better grouped: (585) 555-0142. Anything else is shown as typed. */
export function phoneText(phone: string) {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return phone;
}
