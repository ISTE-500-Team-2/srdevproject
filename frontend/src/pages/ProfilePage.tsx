import { Save, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Toast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import type { User } from '../lib/contracts';

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
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
      setToast('Your profile was saved.');
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
        <form onSubmit={save}>
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
        </form>
      </section>
      <section className="panel feature-notice">
        <h2>Other account settings</h2>
        <p>
          Email changes, password reset, billing, and notification preferences
          are not available in this version.
        </p>
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
