import { Bell, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { Section } from "../profileSections";
import { ZONES } from "./fields";

/** `studioBookingAlerts` comes back only for staff and administrator accounts. */
type NotificationSettings = { enabled: boolean; timeZone: string; studioBookingAlerts?: boolean };

export function NotificationsSection({ readOnly }: { readOnly: boolean }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<NotificationSettings>("/me/notifications", { signal: controller.signal })
      .then(setSettings)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);
  // Each change saves straight away, like a phone's settings screen.
  const update = async (next: NotificationSettings) => {
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
          {settings.studioBookingAlerts !== undefined ? (
            <div className="account-toggle">
              <div>
                <b id="studio-alerts-label">Studio booking alerts</b>
                <p>A copy of every member’s studio booking and cancellation. Your own receipts and notices still come.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.studioBookingAlerts && settings.enabled}
                aria-labelledby="studio-alerts-label"
                className="account-switch"
                disabled={busy || readOnly || !settings.enabled}
                onClick={() => void update({ ...settings, studioBookingAlerts: !settings.studioBookingAlerts })}
              />
            </div>
          ) : null}
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
