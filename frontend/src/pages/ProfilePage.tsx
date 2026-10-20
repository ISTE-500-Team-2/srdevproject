import { SignedWaiverRecords } from "../components/SignedWaiverRecords";
import { Save, SquarePen } from "lucide-react";
import { type FormEvent, useState, useEffect, useRef } from "react";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { ProfileFields, UserProfile } from "../lib/contracts";

const membershipStorageKey = 'profile-membership-selection';
const membershipPlans = [
  { tier: 'Basic', choices: [{ label: 'Monthly', price: '$19.99', value: 'basic-monthly' }, { label: 'Yearly', price: '$99.99', value: 'basic-yearly' }] },
  { tier: 'Premium', choices: [{ label: 'Monthly', price: '$19.99', value: 'premium-monthly' }, { label: 'Yearly', price: '$99.99', value: 'premium-yearly' }] },
  { tier: 'Student', choices: [{ label: 'Monthly', price: '$19.99', value: 'student-monthly' }, { label: 'Yearly', price: '$99.99', value: 'student-yearly' }] },
] as const;
type MembershipSelection = (typeof membershipPlans)[number]['choices'][number]['value'];
const selectableMemberships: MembershipSelection[] = [
  'basic-monthly',
  'basic-yearly',
  'premium-monthly',
  'premium-yearly',
];
const isSelectableMembership = (selection: string): selection is MembershipSelection =>
  selectableMemberships.some((plan) => plan === selection);

const cardStyle = { minHeight: 0, padding: 22, alignSelf: "stretch" } as const;
const cardTitleStyle = { display: "flex", alignItems: "center", justifyContent: "space-between",
  margin: "0 0 20px", paddingBottom: 12, borderBottom: "1px solid var(--border-strong)",
  fontFamily: "inherit", fontSize: "1.5rem" } as const;
const cardGridStyle = { display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20 } as const;
const studioEmail = "info@thecollaboratory.com";

function NotificationSettings() {
  const [settings, setSettings] = useState<{
    enabled: boolean;
    timeZone: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ enabled: boolean; timeZone: string }>("/me/notifications", {
      signal: controller.signal,
    })
      .then(setSettings)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      setSettings(
        await api("/me/notifications", { method: "PATCH", body: settings }),
      );
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="profile-panel panel" style={cardStyle}>
     <h2 style={cardTitleStyle}>Notification Settings</h2>
      <p>
        Choose whether to receive account, booking, payment, waiver, and
        expiration emails. Turning this off disables all notification emails.
      </p>
      {settings ? (
        <form onSubmit={save}>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => {
                setSaved(false);
                setSettings({ ...settings, enabled: e.target.checked });
              }}
            />{" "}
            Receive email notifications
          </label>
          <label className="form-field">
            <span>Time zone for reminders</span>
            <input
              required
              maxLength={100}
              value={settings.timeZone}
              onChange={(e) => {
                setSaved(false);
                setSettings({ ...settings, timeZone: e.target.value });
              }}
              placeholder="America/New_York"
            />
          </label>
          <button
            type="button"
            className="button"
            onClick={() => {
              setSaved(false);
              setSettings({
                ...settings,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              });
            }}
          >
            Use this device’s time zone
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy}
          >
            {busy ? "Saving…" : "Save notification settings"}
          </button>
        </form>
      ) : !error ? (
        <p>Loading notification settings…</p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">Notification settings saved.</p> : null}
    </section>
  );
}

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [membershipSelection, setMembershipSelection] = useState<MembershipSelection>('basic-monthly');
  const [membershipError, setMembershipError] = useState('');
  const firstNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<UserProfile>("/me/profile", { signal: controller.signal })
      .then(setProfile)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    try {
      const savedSelection = window.localStorage.getItem(membershipStorageKey);
      if (savedSelection && isSelectableMembership(savedSelection)) {
        setMembershipSelection(savedSelection);
      }
    } catch {
      setMembershipError('Unable to load your saved membership selection.');
    }
  }, []);
  const changeMembership = () => {
    setMembershipError('');
    try {
      window.localStorage.setItem(membershipStorageKey, membershipSelection);
    } catch {
      setMembershipError('Unable to save your membership selection in this browser.');
      return;
    }
    location.reload();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile) return;
    const form = new FormData(event.currentTarget);
    const fields = (prefix: string): ProfileFields =>
      Object.fromEntries(
        [...form.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), String(value)]),
      );
    setBusy(true);
    setToast(null);
    setError("");
    try {
      const saved = await api<UserProfile>("/me/profile", {
        method: "PATCH",
        body: {
          firstName: String(form.get("firstName")),
          lastName: String(form.get("lastName")),
          phone: String(form.get("phone")),
          address: fields("address."),
          contactPreferences: fields("contact."),
        },
      });
      setProfile(saved);
      setToast("Changes saved.");
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="profile-page page-enter">
      <h1>User Settings</h1>
      <section className="profile-panel panel">
        <form
          key={`${user?.id ?? "guest"}-${user?.firstName ?? ""}-${user?.lastName ?? ""}-${user?.phone ?? ""}-${JSON.stringify(profile?.address ?? {})}-${JSON.stringify(profile?.contactPreferences ?? {})}`}
          onSubmit={save}
          onChange={() => {
            setToast(null);
            setError("");
          }}
        >
          <h2 style={{ ...cardTitleStyle, marginBottom: 0 }}>
  Personal Details
  <button
    type="button"
    aria-label="Edit personal details"
    onClick={() => firstNameRef.current?.focus()}
    style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit" }}
  >
    <SquarePen aria-hidden="true" />
  </button>
</h2>
<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
  <div
    aria-hidden="true"
    style={{
      width: 74,
      height: 74,
      flex: "0 0 auto",
      display: "grid",
      placeItems: "center",
      borderRadius: "50%",
      background: "var(--border)",
    }}
  >
    {user?.firstName.at(0)}
    {user?.lastName.at(0)}
  </div>
  <button
    type="button"
    disabled
    title="Profile photos are not available yet"
    style={{ background: "none", border: 0, padding: 0, color: "inherit" }}
  >
    add image +
  </button>
</div>
          <div className="two-column-fields">
            <label className="form-field">
              <span>First name</span>
              <input
                name="firstName"
                defaultValue={user?.firstName}
                required
                maxLength={50}
                autoComplete="given-name"
              />
            </label>
            <label className="form-field">
              <span>Last name</span>
              <input
                name="lastName"
                defaultValue={user?.lastName}
                required
                maxLength={50}
                autoComplete="family-name"
              />
            </label>
            <label className="form-field form-field--wide">
              <span>Email Address</span>
              <input type="email" value={user?.email ?? ""} readOnly />
            </label>
            <label className="form-field form-field--wide">
              <span>Phone Number</span>
              <input
                name="phone"
                type="tel"
                defaultValue={user?.phone}
                required
                maxLength={15}
                autoComplete="tel"
                ref={firstNameRef}
              />
            </label>
            {["Street address", "City", "State", "Postal code"].map((label) => (
              <label key={label} className="form-field">
                <span>{label}</span>
                <input
                  name={`address.${label}`}
                  defaultValue={String(profile?.address[label] ?? "")}
                  maxLength={200}
                  autoComplete={
                    label === "Street address"
                      ? "street-address"
                      : label === "City"
                        ? "address-level2"
                        : label === "State"
                          ? "address-level1"
                          : "postal-code"
                  }
                />
              </label>
            ))}
            {["Preferred contact method", "Best time to contact"].map(
              (label) => (
                <label key={label} className="form-field">
                  <span>{label}</span>
                  <input
                    name={`contact.${label}`}
                    defaultValue={String(
                      profile?.contactPreferences[label] ?? "",
                    )}
                    maxLength={200}
                  />
                </label>
              ),
            )}
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || !profile}
          >
            <Save aria-hidden="true" />
            {busy ? "Saving…" : "Save changes"}
          </button>
        </form>
      </section>
      {profile ? (
        <section className="profile-panel panel">
          <h2>{profile.studioContact.name}</h2>
          <p>
            Email:{" "}
            <a href={`mailto:${profile.studioContact.email}`}>
              {profile.studioContact.email}
            </a>
          </p>
          {profile.studioContact.phone ? (
            <p>
              Phone:{" "}
              <a href={`tel:${profile.studioContact.phone}`}>
                {profile.studioContact.phone}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="profile-panel panel">
        <h2>Memberships</h2>
        <p>Change your membership tier to your liking. Each membership offers a monthly and yearly plan.</p>
        <div className="membership-options">
          {membershipPlans.map(({ tier, choices }) => (
            <fieldset
              className="membership-option"
              data-selected={choices.some(({ value }) => value === membershipSelection)}
              key={tier}
              disabled={tier === 'Student'}
            >
              <legend>{tier}</legend>
              {choices.map(({ label, price, value }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="membership-option"
                    value={value}
                    checked={membershipSelection === value}
                    onChange={() => setMembershipSelection(value)}
                  />
                  <span>{label}</span>
                  <strong>{price}</strong>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {membershipError ? <p role="alert" className="form-error">{membershipError}</p> : null}
        <button type="button" className="button button--primary membership-change-button" onClick={changeMembership}>
          Change membership option
        </button>
      </section>

      <NotificationSettings />
      <SignedWaiverRecords />
      <section className="panel feature-notice">
        <h2>Other account settings</h2>
        <p>
          Email changes, password reset, and billing are not available in this
          version.
        </p>
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
