import { SignedWaiverRecords } from '../components/SignedWaiverRecords';
import { Save, UserRound } from 'lucide-react';
import { type FormEvent, useState, useEffect } from 'react';
import { Toast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import type { User } from '../lib/contracts';

function NotificationSettings() {
  const [settings,setSettings] = useState<{enabled:boolean;timeZone:string} | null>(null);
  const [error,setError] = useState('');
  const [saved,setSaved] = useState(false);
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{enabled:boolean;timeZone:string}>('/me/notifications',{signal:controller.signal})
      .then(setSettings).catch(err => {if (!controller.signal.aborted) setError(errorMessage(err));});
    return () => controller.abort();
  },[]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true); setSaved(false); setError('');
    try {
      setSettings(await api('/me/notifications',{method:'PATCH',body:settings}));
      setSaved(true);
    } catch(err) {setError(errorMessage(err));} finally {setBusy(false);}
  };
  return <section className="profile-panel panel">
    <h2>Email notifications</h2>
    <p>Choose whether to receive account, booking, payment, waiver, and expiration emails. Turning this off disables all notification emails.</p>
    {settings ? <form onSubmit={save}>
      <label><input type="checkbox" checked={settings.enabled} onChange={e => {setSaved(false);setSettings({...settings,enabled:e.target.checked});}} /> Receive email notifications</label>
      <label className="form-field"><span>Time zone for reminders</span><input required maxLength={100} value={settings.timeZone} onChange={e => {setSaved(false);setSettings({...settings,timeZone:e.target.value});}} placeholder="America/New_York" /></label>
      <button type="button" className="button" onClick={() => {setSaved(false);setSettings({...settings,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});}}>Use this device’s time zone</button>
      <button type="submit" className="button button--primary" disabled={busy}>{busy ? 'Saving…' : 'Save notification settings'}</button>
    </form> : !error ? <p>Loading notification settings…</p> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    {saved ? <p role="status">Notification settings saved.</p> : null}
  </section>;
}

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setSaved(false);
    setToast(null);
    setError('');
    try {
      await api<User>('/me/profile', {
        method: 'PATCH',
        body: {
          firstName: String(form.get('firstName')),
          lastName: String(form.get('lastName')),
          phone: String(form.get('phone')),
        },
      });
      setSaved(true);
      setToast('Changes saved.');
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
      <section className="profile-panel panel">
        <form onSubmit={save} onChange={() => { setSaved(false); setToast(null); setError(''); }}>
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
              <span>Email</span>
              <input type="email" value={user?.email ?? ''} readOnly />
            </label>
            <label className="form-field form-field--wide">
              <span>Phone</span>
              <input
                name="phone"
                type="tel"
                defaultValue={user?.phone}
                required
                maxLength={15}
                autoComplete="tel"
              />
            </label>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={busy}
          >
            <Save aria-hidden="true" />
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {saved ? <p className="form-success" role="status">Changes saved.</p> : null}
        </form>
      </section>
      <NotificationSettings />
      <SignedWaiverRecords />
      <section className="panel feature-notice">
        <h2>Other account settings</h2>
        <p>
          Email changes, password reset, and billing
          are not available in this version.
        </p>
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
