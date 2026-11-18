// Member settings are split into independently saved sections so editing contact details does not
// replace unrelated preferences.

import {
  BadgeCheck,
  Bell,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  Download,
  FileText,
  LifeBuoy,
  Mail,
  MessageSquare,
  Phone,
  ShieldCheck,
  UserPlus,
  UserRound,
  Users,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import HoldButton from "../components/reactbits/HoldButton";
import { AccountPhoto } from "../components/AccountPhoto";
import { ProfilePhotoSetting } from "../components/ProfilePhotoSetting";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { ProfileFields, SupervisedMinors, User, UserProfile } from "../lib/contracts";
import type { SignedWaiver } from "../lib/billingContracts";
import type { MembershipHistory, Page, Payment } from "../lib/staffContracts";
import { dollars, shortDate, timeOnly } from "../lib/display";
import { jumpToSection } from "../lib/sectionJump";
import { useApi } from "../lib/useApi";
import { Detail, EditButton, FormMessage, Section, SectionForm, useReturnFocus } from "./profileSections";
import { SignInSection } from "./ProfileSignIn";
import "./profile.css";

// Keys the profile API stores address and contact details under.
const ADDRESS = ["Street address", "City", "State", "Postal code"] as const;
const CONTACT_METHOD = "Preferred contact method";
const CONTACT_TIME = "Best time to contact";
const METHODS: { value: string; Icon: LucideIcon }[] = [
  { value: "Email", Icon: Mail },
  { value: "Text", Icon: MessageSquare },
  { value: "Call", Icon: Phone },
];
const TIMES = ["Morning", "Afternoon", "Evening"];
const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
const ZONES = [
  ["America/New_York", "Eastern Time (New York)"],
  ["America/Chicago", "Central Time (Chicago)"],
  ["America/Denver", "Mountain Time (Denver)"],
  ["America/Phoenix", "Mountain Time, no DST (Phoenix)"],
  ["America/Los_Angeles", "Pacific Time (Los Angeles)"],
  ["America/Anchorage", "Alaska Time (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii Time (Honolulu)"],
];
const SECTIONS: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", Icon: UserRound },
  { id: "contact", label: "Contact", Icon: Phone },
  { id: "sign-in", label: "Sign-in", Icon: KeyRound },
  { id: "billing", label: "Membership & billing", Icon: CreditCard },
  { id: "minors", label: "Minors", Icon: Users },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "documents", label: "Documents", Icon: FileText },
  { id: "help", label: "Help", Icon: LifeBuoy },
];

const text = (fields: ProfileFields | undefined, key: string) => String(fields?.[key] ?? "").trim();
const digits = (value: string) => value.replace(/\D/g, "");
/**
 * The phone number as stored: its digits, keeping a leading "+" for an international number.
 * Anything else (letters, an extension, too few or too many digits) is refused with a message
 * rather than having characters silently dropped. The column holds 15 characters.
 */
export function phoneToSave(value: string) {
  const entered = value.trim();
  const saved = (entered.startsWith("+") ? "+" : "") + digits(entered);
  if (!/^\+?[\d\s().-]+$/.test(entered))
    throw new FormMessage("Enter just the number: digits, spaces, dashes or brackets, and a leading + if it’s international. Extensions can’t be saved.");
  if (digits(entered).length < 7) throw new FormMessage("That phone number is too short. Include the area code.");
  if (saved.length > 15) throw new FormMessage("That phone number is too long.");
  return saved;
}
/**
 * (410) 555-0182 for US numbers: ten digits, or eleven starting with 1 (with or without a "+").
 * Anything else, including a ten-digit number with a "+" country code such as +49 30 123456,
 * is shown as entered, so the edit form saves it back with its "+".
 */
export function formatPhone(value: string) {
  const d = digits(value);
  const international = value.trim().startsWith("+");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 && !international ? d : "";
  return ten ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value;
}

type Save = (change: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: ProfileFields;
  contactPreferences?: ProfileFields;
}) => Promise<void>;

function Choice({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: { value: string; Icon?: LucideIcon }[];
  value: string;
}) {
  const [picked, setPicked] = useState(value);
  // Older profiles allowed free text. Keep that saved choice until the member
  // deliberately selects one of the newer options.
  const choices: typeof options = value && !options.some((option) => option.value === value)
    ? [{ value }, ...options]
    : options;
  return (
    <fieldset className="account-choice">
      <legend>{label}</legend>
      <div className="account-choice__options">
        {choices.map(({ value: option, Icon }) => (
          <label key={option} className={picked === option ? "is-on" : ""}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={picked === option}
              onChange={() => setPicked(option)}
            />
            {Icon ? <Icon aria-hidden="true" /> : null}
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ProfileSection({
  user,
  profile,
  save,
  notify,
  readOnly,
}: {
  user: User;
  profile: UserProfile | null;
  save: Save;
  notify: (message: string) => void;
  /** Staff with the member's account open: the server refuses these changes. */
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const opener = useReturnFocus(editing);
  return (
    <Section
      id="profile"
      title="Profile"
      note="Your name as staff and instructors see it."
      Icon={UserRound}
      editing={editing}
      action={
        !editing && profile && !readOnly ? <EditButton ref={opener} label="Edit profile" onClick={() => setEditing(true)} /> : null
      }
    >
      {editing ? (
        <SectionForm
          saveLabel="Save profile"
          onCancel={() => setEditing(false)}
          onSave={async (form) => {
            await save({
              firstName: String(form.get("firstName")),
              lastName: String(form.get("lastName")),
            });
            setEditing(false);
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>First name</span>
              <input name="firstName" defaultValue={user.firstName} required maxLength={50} autoComplete="given-name" />
            </label>
            <label className="form-field">
              <span>Last name</span>
              <input name="lastName" defaultValue={user.lastName} required maxLength={50} autoComplete="family-name" />
            </label>
          </div>
          <p className="account-hint">Change the email you sign in with under Sign-in.</p>
        </SectionForm>
      ) : (
        <>
          <ProfilePhotoSetting notify={notify} />
          <dl className="account-details">
            <Detail label="Name">
              {user.firstName} {user.lastName}
            </Detail>
            <Detail label="Email">{user.email}</Detail>
          </dl>
        </>
      )}
    </Section>
  );
}

function ContactSection({
  user,
  profile,
  save,
  readOnly,
  missing,
}: {
  user: User;
  profile: UserProfile | null;
  save: Save;
  readOnly: boolean;
  /** Shown instead of "Not added" while the profile is loading or after it failed to load. */
  missing?: string;
}) {
  const [editing, setEditing] = useState(false);
  const opener = useReturnFocus(editing);
  const address = profile?.address;
  const prefs = profile?.contactPreferences;
  const state = text(address, "State");
  const line = [
    text(address, "Street address"),
    text(address, "City"),
    [state, text(address, "Postal code")].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const how = [text(prefs, CONTACT_METHOD), text(prefs, CONTACT_TIME).toLowerCase()].filter(Boolean).join(" · ");
  return (
    <Section
      id="contact"
      title="Contact"
      note="How the studio reaches you about bookings and access."
      Icon={Phone}
      editing={editing}
      action={
        !editing && profile && !readOnly ? <EditButton ref={opener} label="Edit contact" onClick={() => setEditing(true)} /> : null
      }
    >
      {editing ? (
        <SectionForm
          saveLabel="Save contact"
          onCancel={() => setEditing(false)}
          onSave={async (form) => {
            const field = (key: string) => String(form.get(key) ?? "").trim();
            await save({
              phone: phoneToSave(field("phone")),
              // Merge, so keys this page doesn't show (a gate code, an SMS
              // opt-in) survive the save.
              address: {
                ...profile?.address,
                ...Object.fromEntries(ADDRESS.map((key) => [key, field(key)])),
              },
              contactPreferences: {
                ...profile?.contactPreferences,
                [CONTACT_METHOD]: field(CONTACT_METHOD),
                [CONTACT_TIME]: field(CONTACT_TIME),
              },
            });
            setEditing(false);
          }}
        >
          <div className="account-fields">
            <label className="form-field form-field--wide">
              <span>Phone</span>
              <input
                name="phone"
                type="tel"
                inputMode="tel"
                required
                defaultValue={formatPhone(user.phone ?? "")}
                autoComplete="tel"
                placeholder="(410) 555-0182"
              />
            </label>
            <label className="form-field form-field--wide">
              <span>Street address</span>
              <input name="Street address" defaultValue={text(address, "Street address")} maxLength={200} autoComplete="street-address" />
            </label>
            <label className="form-field">
              <span>City</span>
              <input name="City" defaultValue={text(address, "City")} maxLength={200} autoComplete="address-level2" />
            </label>
            <div className="account-fields account-fields--pair">
              <label className="form-field">
                <span>State</span>
                <select name="State" defaultValue={state} autoComplete="address-level1">
                  <option value="">Choose</option>
                  {/* Keep an older free-text value selectable until it's changed. */}
                  {state && !STATES.includes(state) ? <option value={state}>{state}</option> : null}
                  {STATES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Postal code</span>
                <input
                  name="Postal code"
                  defaultValue={text(address, "Postal code")}
                  maxLength={10}
                  inputMode="numeric"
                  autoComplete="postal-code"
                />
              </label>
            </div>
            <Choice name={CONTACT_METHOD} label="Preferred contact" options={METHODS} value={text(prefs, CONTACT_METHOD)} />
            <Choice
              name={CONTACT_TIME}
              label="Best time"
              options={TIMES.map((value) => ({ value }))}
              value={text(prefs, CONTACT_TIME)}
            />
          </div>
        </SectionForm>
      ) : (
        <dl className="account-details">
          <Detail label="Phone">{user.phone ? formatPhone(user.phone) : ""}</Detail>
          <Detail label="Address" empty={missing}>
            {line}
          </Detail>
          <Detail label="Preferred contact" empty={missing}>
            {how}
          </Detail>
        </dl>
      )}
    </Section>
  );
}

function BillingSection() {
  const history = useApi<MembershipHistory>("/me/memberships");
  // Only payments actually made: an abandoned or unfinished checkout leaves a void or pending row.
  const payments = useApi<Page<Payment>>("/me/payments?offset=0&status=paid");
  const membership = history.data?.memberships.find((m) => m.effectiveStatus === "active");
  const pass = history.data?.passes.find((p) => p.effectiveStatus === "active");
  const current = membership ?? pass;
  const last = payments.data?.items[0];
  return (
    <Section
      id="billing"
      title="Membership & billing"
      note="Your plan, current period and latest payment."
      Icon={CreditCard}
      action={
        <Link className="button button--primary account-edit" to="/membership">
          Manage <ChevronRight aria-hidden="true" />
        </Link>
      }
    >
      {history.error || payments.error ? <p className="form-error">{history.error || payments.error}</p> : null}
      <div className="account-plan">
        <div>
          <strong className="account-plan__name">
            {current?.plan?.name ?? (history.data ? "No active plan" : history.error ? "Plan unavailable" : "…")}
          </strong>
          {current ? (
            <span className="status-pill status-pill--ok">{membership ? "Active" : "Day pass today"}</span>
          ) : null}
        </div>
        <dl className="account-details account-details--inline">
          {/* With no plan or pass there is no period to show; the name above already says so. */}
          {current ? (
            <Detail label={membership ? "Current period ends" : "Valid"}>
              {membership?.endsAt
                ? shortDate(membership.endsAt, true)
                : pass?.validDate
                  ? shortDate(pass.validDate, true)
                  : ""}
            </Detail>
          ) : null}
          <Detail label="Latest payment" empty={payments.error ? "Unavailable" : "Loading…"}>
            {last ? `${dollars(last.amount)} · ${shortDate(last.recordedAt)}` : payments.data ? "None yet" : ""}
          </Detail>
        </dl>
      </div>
    </Section>
  );
}

/** Adults link a child's account here; the child accepts in their own account. */
function MinorsSection({ notify, readOnly }: { notify: (message: string) => void; readOnly: boolean }) {
  const state = useApi<SupervisedMinors>("/me/minors", { retainOnReload: true });
  const [adding, setAdding] = useState(false);
  const opener = useReturnFocus(adding);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const minors = state.data?.minors ?? [];
  const requests = state.data?.requests ?? [];
  // The server only takes requests from active adults with a date of birth on file; older
  // accounts have none, so they're told what to do instead of being offered a form that fails.
  const canLink = !readOnly && state.data?.canSponsor === true;
  const act = async (key: string, path: string, message: string) => {
    setBusy(key);
    setError("");
    try {
      await api(path, { method: "POST", body: {} });
      state.reload();
      notify(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      id="minors"
      title="Minors you supervise"
      note="Members under 18 visit with you and check out when you do."
      Icon={Users}
      editing={adding}
      action={
        canLink && !adding ? (
          <button ref={opener} type="button" className="button button--quiet account-edit" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" /> Link a minor
          </button>
        ) : null
      }
    >
      {state.loading && !state.data ? <p role="status">Loading minors…</p> : null}
      {state.error ? <p className="form-error">{state.error}</p> : null}
      {adding ? (
        <SectionForm
          saveLabel="Send request"
          onCancel={() => setAdding(false)}
          onSave={async (form) => {
            const sent = await api<{ minorName: string }>("/me/minors/requests", {
              method: "POST",
              body: { email: String(form.get("email") ?? "").trim(), dob: String(form.get("dob") ?? "") },
            });
            setAdding(false);
            state.reload();
            notify(`Request sent to ${sent.minorName}.`);
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>Their account email</span>
              <input name="email" type="email" required maxLength={255} autoComplete="off" />
            </label>
            <label className="form-field">
              <span>Their date of birth</span>
              <input name="dob" type="date" required max={new Date().toISOString().slice(0, 10)} />
            </label>
          </div>
          <p className="account-hint">
            They’ll see your request on their home page and choose whether to accept. Both of you need your own
            membership or pass and signed waivers to visit.
          </p>
        </SectionForm>
      ) : null}
      {state.data && !readOnly && !state.data.canSponsor ? (
        <p className="account-hint">
          {state.data.dobOnFile
            ? "Linking a minor needs an account with active access. Ask staff about your account."
            : "Linking a minor needs your date of birth, and there isn’t one on file for your account. Ask staff to add it."}
        </p>
      ) : null}
      {state.data && !minors.length && !requests.length && !adding ? (
        <p className="account-hint">
          No minors linked yet.
          {canLink ? (
            <>
              {" "}
              <button type="button" className="account-hint__action" onClick={() => setAdding(true)}>
                Link a child’s account
              </button>{" "}
              to visit together.
            </>
          ) : null}
        </p>
      ) : null}
      {minors.length || requests.length ? (
        <ul className="account-docs account-docs--people">
          {minors.map((minor) => (
            <li key={`minor-${minor.id}`}>
              <span className="account-docs__icon">
                <UserRound aria-hidden="true" />
              </span>
              <div>
                <b>{minor.name}</b>
                <p>
                  {minor.visit
                    ? `Checked in since ${timeOnly(minor.visit.checkedInAt)} · ${minor.visit.buildingName}`
                    : "Not in the building"}
                </p>
              </div>
              {readOnly ? null : (
                <HoldButton
                  className="site-hold-button"
                  disabled={busy !== null}
                  holdTime={1200}
                  radius={9}
                  backgroundColor="var(--hold-danger-bg)"
                  fillColor="var(--hold-danger)"
                  textColor="var(--hold-danger-text)"
                  fillTextColor="var(--hold-danger-ink)"
                  doneLabel="Unlinking…"
                  onHold={() =>
                    void act(`unlink-${minor.id}`, `/me/minors/${minor.id}/unlink`, `${minor.name} is no longer linked to you.`)
                  }
                >
                  Hold to unlink
                </HoldButton>
              )}
            </li>
          ))}
          {requests.map((request) => (
            <li key={`request-${request.id}`}>
              <span className="account-docs__icon">
                <Clock aria-hidden="true" />
              </span>
              <div>
                <b>{request.minorName}</b> <span className="status-pill status-pill--neutral">Pending</span>
                <p>Sent {shortDate(request.createdAt)} · waiting for them to accept</p>
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy !== null}
                  aria-label={`Cancel request to ${request.minorName}`}
                  onClick={() =>
                    void act(
                      `cancel-${request.id}`,
                      `/me/minors/requests/${request.id}/cancel`,
                      `Request to ${request.minorName} cancelled.`,
                    )
                  }
                >
                  {busy === `cancel-${request.id}` ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

function NotificationsSection({ readOnly }: { readOnly: boolean }) {
  const [settings, setSettings] = useState<{ enabled: boolean; timeZone: string } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ enabled: boolean; timeZone: string }>("/me/notifications", { signal: controller.signal })
      .then(setSettings)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
  // Each change saves straight away, like a phone's settings screen.
  const update = async (next: { enabled: boolean; timeZone: string }) => {
    const previous = settings;
    setSettings(next);
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      setSettings(await api("/me/notifications", { method: "PATCH", body: next }));
      setSaved(true);
    } catch (err) {
      setSettings(previous);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...ZONES];
  for (const zone of [settings?.timeZone, device])
    if (zone && !zones.some(([z]) => z === zone)) zones.push([zone, zone.replace(/_/g, " ")]);
  return (
    <Section
      id="notifications"
      title="Notifications"
      note="Account, booking, payment and waiver emails."
      Icon={Bell}
      action={saved ? <span className="account-saved" role="status"><Check aria-hidden="true" /> Saved</span> : null}
    >
      {!settings && !error ? <p role="status">Loading notification settings…</p> : null}
      {settings ? (
        <>
          <div className="account-toggle">
            <div>
              <b id="email-toggle-label">Email me</b>
              <p>Confirmations, changes, reminders and expiry notices. Turn off to stop all of them.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.enabled}
              aria-labelledby="email-toggle-label"
              className="account-switch"
              disabled={busy || readOnly}
              onClick={() => void update({ ...settings, enabled: !settings.enabled })}
            />
          </div>
          <div className="account-toggle">
            <div>
              <b>Reminder time zone</b>
              <p>Reminder times in emails use this zone.</p>
            </div>
            <select
              aria-label="Reminder time zone"
              value={settings.timeZone}
              disabled={busy || readOnly}
              onChange={(e) => void update({ ...settings, timeZone: e.target.value })}
            >
              {zones.map(([zone, label]) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {readOnly ? <p className="account-hint">Members change their own notification settings.</p> : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

/** `adminOnly`: staff other than administrators can't open signed copies from a member's account. */
function DocumentsSection({ adminOnly }: { adminOnly: boolean }) {
  const records = useApi<SignedWaiver[]>(adminOnly ? null : "/me/signed-waivers");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const download = async (id: number) => {
    setError("");
    setBusy(id);
    try {
      const copy = await api<{ fileName: string; content: string }>(`/me/signed-waivers/${id}/copy`);
      const url = URL.createObjectURL(new Blob([copy.content], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = copy.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section id="documents" title="Documents" note="Copies of the waivers you've signed." Icon={FileText}>
      {adminOnly ? <p className="account-hint">Only administrators can open signed waiver copies.</p> : null}
      {records.loading && !records.data ? <p role="status">Loading documents…</p> : null}
      {records.error ? <p className="form-error">{records.error}</p> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {records.data?.length === 0 ? (
        <p className="account-hint">
          Nothing signed yet. <Link to="/certifications">Review your waivers</Link>
        </p>
      ) : null}
      <ul className="account-docs">
        {records.data?.map((record) => (
          <li key={record.id}>
            <span className="account-docs__icon">
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <b>{record.name}</b>
              <p>
                {record.version} · signed {shortDate(record.signedAt, true)}
                {record.expiresAt ? ` · expires ${shortDate(record.expiresAt, true)}` : ""}
              </p>
            </div>
            {record.copyAvailable ? (
              <button
                type="button"
                className="button button--quiet"
                disabled={busy !== null}
                onClick={() => void download(record.id)}
                aria-label={`Download signed copy of ${record.name}`}
              >
                <Download aria-hidden="true" /> {busy === record.id ? "Preparing…" : "Copy"}
              </button>
            ) : (
              <span className="account-docs__none">Ask staff for this older record</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function HelpSection({ profile }: { profile: UserProfile | null }) {
  const contact = profile?.studioContact;
  return (
    <section id="help" className="account-help" aria-labelledby="help-title">
      <span className="account-help__icon">
        <LifeBuoy aria-hidden="true" />
      </span>
      <div>
        <h2 id="help-title" tabIndex={-1}>
          Need a hand?
        </h2>
        <p>
          Contact {contact?.name ?? "the studio"} with any questions about your account.
        </p>
      </div>
      {contact ? (
        <div className="account-help__actions">
          <a className="button" href={`mailto:${contact.email}`}>
            <Mail aria-hidden="true" /> {contact.email}
          </a>
          {contact.phone ? (
            <a className="button" href={`tel:${contact.phone}`}>
              <Phone aria-hidden="true" /> {formatPhone(contact.phone)}
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Highlights the section menu entry for whatever is on screen. */
function useCurrentSection(sections: typeof SECTIONS) {
  const [current, setCurrent] = useState(sections[0]!.id);
  const ids = sections.map((s) => s.id).join(" ");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCurrent(visible.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const id of ids.split(" ")) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return current;
}

export function ProfilePage() {
  const { user, actor, refresh } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const latestProfile = useRef<UserProfile | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const active = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Staff with a member's account open see the member's settings but can't change them.
  const acting = !!actor && !!user && actor.id !== user.id;
  // Only adults sponsor minors; the session says whether this account is under 18.
  const sponsors = user?.isMinor === false;
  const sections = sponsors ? SECTIONS : SECTIONS.filter((s) => s.id !== "minors");
  const current = useCurrentSection(sections);
  // Email links land on a section (e.g. #minors); scroll once the profile has laid out.
  const landed = useRef(false);
  useEffect(() => {
    if (!profile || landed.current) return;
    landed.current = true;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [profile]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<UserProfile>("/me/profile", { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        latestProfile.current = loaded;
        setProfile(loaded);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [attempt]);
  const updateProfile = (change: Partial<UserProfile>) => {
    if (!latestProfile.current) return;
    latestProfile.current = { ...latestProfile.current, ...change };
    setProfile(latestProfile.current);
  };
  // Sections can save together, but the API replaces all identity fields.
  // Build each request from the preceding response, never a render's snapshot.
  const save: Save = (change) => {
    const request = saveQueue.current.then(async () => {
      if (!active.current) return;
      const stored = latestProfile.current;
      if (!stored) throw new Error("Your profile is still loading. Try again.");
      setToast(null);
      const saved = await api<UserProfile>("/me/profile", {
        method: "PATCH",
        body: {
          firstName: change.firstName ?? stored.user.firstName,
          lastName: change.lastName ?? stored.user.lastName,
          phone: change.phone ?? stored.user.phone,
          address: change.address ?? stored.address,
          contactPreferences: change.contactPreferences ?? stored.contactPreferences,
        },
      });
      if (!active.current) return;
      latestProfile.current = saved;
      setProfile(saved);
      setToast("Changes saved.");
      await refresh(false, { fresh: true });
    });
    // One failed section must not prevent another queued section from saving.
    saveQueue.current = request.catch(() => {});
    return request;
  };
  if (!user) return null;
  return (
    <div className="account-page page-enter">
      <section className="account-hero">
        <AccountPhoto person={user} className="profile-hero__avatar" />
        <div>
          <h1>
            {user.firstName} {user.lastName}
          </h1>
          <div className="account-hero__facts">
            {user.membership !== "None" ? <span className="membership-pill">{user.membership === "Day Pass" ? "Day pass" : `${user.membership} membership`}</span> : null}
            <span>
              <BadgeCheck aria-hidden="true" /> Member ID {String(user.id).padStart(6, "0")}
            </span>
            <span>
              <Mail aria-hidden="true" /> {user.email}
            </span>
          </div>
        </div>
      </section>
      {acting ? (
        <p className="account-acting">
          You’re viewing {user.firstName}’s settings. Members change these themselves; to fix {user.firstName}’s name or phone, or add a
          missing date of birth, open <Link to={`/admin/members?member=${user.id}`}>their member record</Link>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}{" "}
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="account-layout">
        <nav className="account-nav" aria-label="Account sections">
          {sections.map(({ id, label, Icon }) => (
            <a key={id} href={`#${id}`} className={current === id ? "is-active" : ""} aria-current={current === id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jumpToSection(id);
              }}
            >
              <Icon aria-hidden="true" /> {label}
            </a>
          ))}
        </nav>
        <div className="account-main">
          <ProfileSection user={user} profile={profile} save={save} notify={setToast} readOnly={acting} />
          <ContactSection
            user={user}
            profile={profile}
            save={save}
            readOnly={acting}
            missing={profile ? undefined : error ? "Unavailable" : "Loading…"}
          />
          <SignInSection profile={profile} onProfile={updateProfile} notify={setToast} />
          <BillingSection />
          {sponsors ? <MinorsSection notify={setToast} readOnly={acting} /> : null}
          <NotificationsSection readOnly={acting} />
          <DocumentsSection adminOnly={acting && !actor?.roles.includes("admin")} />
          <HelpSection profile={profile} />
        </div>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
