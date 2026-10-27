import {
  BadgeCheck,
  Bell,
  Check,
  ChevronRight,
  CreditCard,
  Download,
  FileText,
  LifeBuoy,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { ProfileFields, User, UserProfile } from "../lib/contracts";
import type { SignedWaiver } from "../lib/billingContracts";
import type { MembershipHistory, Page, Payment } from "../lib/staffContracts";
import { dollars, shortDate } from "../lib/display";
import { useApi } from "../lib/useApi";
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
  { id: "billing", label: "Membership & billing", Icon: CreditCard },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "documents", label: "Documents", Icon: FileText },
  { id: "help", label: "Help", Icon: LifeBuoy },
];

const text = (fields: ProfileFields | undefined, key: string) => String(fields?.[key] ?? "").trim();
const digits = (value: string) => value.replace(/\D/g, "");
/** (410) 555-0182 for ten-digit US numbers; anything else as entered. */
export function formatPhone(value: string) {
  const d = digits(value);
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value;
}

type Save = (change: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: ProfileFields;
  contactPreferences?: ProfileFields;
}) => Promise<void>;

function Section({
  id,
  title,
  note,
  Icon,
  action,
  editing,
  children,
}: {
  id: string;
  title: string;
  note: string;
  Icon: LucideIcon;
  action?: ReactNode;
  editing?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`account-section${editing ? " account-section--editing" : ""}`} aria-labelledby={`${id}-title`}>
      <header className="account-section__head">
        <span className="account-section__icon">
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{note}</p>
        </div>
        {action}
      </header>
      <div className="account-section__body">{children}</div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="account-detail">
      <dt>{label}</dt>
      <dd>{children || <span className="account-detail__empty">Not added</span>}</dd>
    </div>
  );
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="button button--quiet account-edit" onClick={onClick} aria-label={label}>
      <Pencil aria-hidden="true" /> Edit
    </button>
  );
}

/** A form that saves one section and reports its own errors. */
function SectionForm({
  onSave,
  onCancel,
  saveLabel,
  children,
}: {
  onSave: (form: FormData) => Promise<void>;
  onCancel: () => void;
  saveLabel: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(new FormData(event.currentTarget));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form" onSubmit={(e) => void submit(e)}>
      {children}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="account-form__actions">
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          <Check aria-hidden="true" /> {busy ? "Saving…" : saveLabel}
        </button>
      </div>
    </form>
  );
}

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
  return (
    <fieldset className="account-choice">
      <legend>{label}</legend>
      <div className="account-choice__options">
        {options.map(({ value: option, Icon }) => (
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

function ProfileSection({ user, profile, save }: { user: User; profile: UserProfile | null; save: Save }) {
  const [editing, setEditing] = useState(false);
  return (
    <Section
      id="profile"
      title="Profile"
      note="Your name as staff and instructors see it."
      Icon={UserRound}
      editing={editing}
      action={!editing && profile ? <EditButton label="Edit profile" onClick={() => setEditing(true)} /> : null}
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
          <p className="account-hint">Your email is how you sign in. Ask staff to change it.</p>
        </SectionForm>
      ) : (
        <dl className="account-details">
          <Detail label="Name">
            {user.firstName} {user.lastName}
          </Detail>
          <Detail label="Email">{user.email}</Detail>
          {user.username ? <Detail label="Username">{user.username}</Detail> : null}
        </dl>
      )}
    </Section>
  );
}

function ContactSection({ user, profile, save }: { user: User; profile: UserProfile | null; save: Save }) {
  const [editing, setEditing] = useState(false);
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
      action={!editing && profile ? <EditButton label="Edit contact" onClick={() => setEditing(true)} /> : null}
    >
      {editing ? (
        <SectionForm
          saveLabel="Save contact"
          onCancel={() => setEditing(false)}
          onSave={async (form) => {
            const field = (key: string) => String(form.get(key) ?? "").trim();
            await save({
              phone: digits(field("phone")),
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
                pattern="[\d\s()+.\-]{7,20}"
                title="Enter a phone number, e.g. (410) 555-0182"
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
          <Detail label="Address">{line}</Detail>
          <Detail label="Preferred contact">{how}</Detail>
        </dl>
      )}
    </Section>
  );
}

function BillingSection() {
  const history = useApi<MembershipHistory>("/me/memberships");
  const payments = useApi<Page<Payment>>("/me/payments?offset=0");
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
      {history.error ? <p className="form-error">{history.error}</p> : null}
      <div className="account-plan">
        <div>
          <strong className="account-plan__name">
            {current?.plan?.name ?? (history.data ? "No active plan" : "…")}
          </strong>
          {current ? (
            <span className="status-pill status-pill--ok">{membership ? "Active" : "Day pass today"}</span>
          ) : null}
        </div>
        <dl className="account-details account-details--inline">
          <Detail label={membership ? "Current period ends" : "Valid"}>
            {membership?.endsAt
              ? shortDate(membership.endsAt, true)
              : pass?.validDate
                ? shortDate(pass.validDate, true)
                : ""}
          </Detail>
          <Detail label="Latest payment">
            {last ? `${dollars(last.amount)} · ${shortDate(last.recordedAt)}` : payments.data ? "None yet" : ""}
          </Detail>
        </dl>
      </div>
    </Section>
  );
}

function NotificationsSection() {
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
              disabled={busy}
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
              disabled={busy}
              onChange={(e) => void update({ ...settings, timeZone: e.target.value })}
            >
              {zones.map(([zone, label]) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </select>
          </div>
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

function DocumentsSection() {
  const records = useApi<SignedWaiver[]>("/me/signed-waivers");
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
        <h2 id="help-title">Need a hand?</h2>
        <p>
          Contact {contact?.name ?? "the studio"}. Email and password changes go through staff for now.
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
function useCurrentSection() {
  const [current, setCurrent] = useState(SECTIONS[0]!.id);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCurrent(visible.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState("");
  const current = useCurrentSection();
  useEffect(() => {
    const controller = new AbortController();
    api<UserProfile>("/me/profile", { signal: controller.signal })
      .then(setProfile)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
  // The profile API replaces every field at once, so each section sends the
  // stored values with its own changes on top.
  const save: Save = async (change) => {
    if (!user || !profile) return;
    setToast(null);
    const saved = await api<UserProfile>("/me/profile", {
      method: "PATCH",
      body: {
        firstName: change.firstName ?? user.firstName,
        lastName: change.lastName ?? user.lastName,
        phone: change.phone ?? user.phone,
        address: change.address ?? profile.address,
        contactPreferences: change.contactPreferences ?? profile.contactPreferences,
      },
    });
    setProfile(saved);
    setToast("Changes saved.");
    await refresh();
  };
  if (!user) return null;
  return (
    <div className="account-page page-enter">
      <section className="account-hero">
        <div className="profile-hero__avatar" aria-hidden="true">
          {user.firstName.at(0)}
          {user.lastName.at(0)}
        </div>
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
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="account-layout">
        <nav className="account-nav" aria-label="Account sections">
          {SECTIONS.map(({ id, label, Icon }) => (
            <a key={id} href={`#${id}`} className={current === id ? "is-active" : ""} aria-current={current === id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <Icon aria-hidden="true" /> {label}
            </a>
          ))}
        </nav>
        <div className="account-main">
          <ProfileSection user={user} profile={profile} save={save} />
          <ContactSection user={user} profile={profile} save={save} />
          <BillingSection />
          <NotificationsSection />
          <DocumentsSection />
          <HelpSection profile={profile} />
        </div>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
