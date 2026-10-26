import { SignedWaiverRecords } from "../components/SignedWaiverRecords";
import { Save, UserRound } from "lucide-react";
import { type FormEvent, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { ProfileFields, UserProfile } from "../lib/contracts";

const cardStyle = { minHeight: 0 } as const;
// Cards grow to fill each row and wrap onto a new row on narrow screens.
const cardFlex = (grow: number, basis: number) =>
  ({ ...cardStyle, flex: `${grow} 1 ${basis}px`, minWidth: 0 }) as const;
const cardGridStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "stretch",
  gap: 20,
} as const;

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
    <section className="profile-panel panel" style={cardFlex(1, 300)}>
      <h2>Notification Settings</h2>
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
  useEffect(() => {
    const controller = new AbortController();
    api<UserProfile>("/me/profile", { signal: controller.signal })
      .then(setProfile)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
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
      <section className="profile-hero">
        <div className="profile-hero__avatar">
          {user?.firstName.at(0)}
          {user?.lastName.at(0)}
        </div>
        <div>
          <p className="eyebrow">Account</p>
          <h1>
            {user?.firstName} {user?.lastName}
          </h1>
          <span>{user?.role}</span>
        </div>
      </section>
      <div style={cardGridStyle}>
        <section className="profile-panel panel" style={cardFlex(1.2, 340)}>
          <form
            key={`${user?.id ?? "guest"}-${user?.firstName ?? ""}-${user?.lastName ?? ""}-${user?.phone ?? ""}-${JSON.stringify(profile?.address ?? {})}-${JSON.stringify(profile?.contactPreferences ?? {})}`}
            onSubmit={save}
            onChange={() => {
              setToast(null);
              setError("");
            }}
          >
            <h2>
              <UserRound aria-hidden="true" /> Personal information
            </h2>
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
                <span>Username</span>
                <input value={user?.username ?? ""} placeholder="Existing account — sign in with your email" readOnly />
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

        <section className="profile-panel panel" style={cardFlex(1.4, 340)}>
          <h2>Membership</h2>
          <p>Current membership access: <strong>{user?.membership ?? 'None'}</strong>.</p>
          <p>Review current plans, prices, eligibility and payment status before making a change.</p>
          <Link className="button button--primary" to="/membership">
            Manage membership and passes
          </Link>
        </section>

        <NotificationSettings />
      </div>

      <div style={cardGridStyle}>
        <section className="profile-panel panel" style={cardFlex(1.5, 300)}>
          <h2>Payments</h2>
          <p>View receipts, manage payment details and check refunds in your billing workspace.</p>
          <Link to="/membership">Manage payments</Link>
        </section>
      </div>

      <SignedWaiverRecords />
      <section className="panel feature-notice">
        <h2>Other account settings</h2>
        <p>
          Email changes and password reset are not available in this
          version.
        </p>
      </section>

      <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--border-strong)", margin: 0 }} />
      {profile ? <section aria-labelledby="studio-contact-heading">
        <h2 id="studio-contact-heading">Contact {profile.studioContact.name}</h2>
        <p><a href={`mailto:${profile.studioContact.email}`}>{profile.studioContact.email}</a></p>
        {profile.studioContact.phone ? <p><a href={`tel:${profile.studioContact.phone}`}>{profile.studioContact.phone}</a></p> : null}
      </section> : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
