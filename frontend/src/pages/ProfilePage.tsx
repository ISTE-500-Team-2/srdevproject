import {
  Accessibility,
  Bell,
  Check,
  CreditCard,
  ExternalLink,
  ImagePlus,
  Pencil,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Toast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { useAccountPreferences } from '../context/AccountPreferencesContext';
import { api, errorMessage } from '../lib/api';
import type { AccountPreferences, User } from '../lib/contracts';
import { useApi } from '../lib/useApi';
import type { Entitlement, MembershipHistory, Page, Payment } from '../lib/staffContracts';
import { dollars } from '../components/Management';

const notificationOptions = [
  ['reservations', 'Reservation updates', 'Changes to your equipment bookings.'],
  ['classes', 'Class announcements', 'Class schedule and registration updates.'],
  ['membershipPayments', 'Membership and payment notices', 'Membership and recorded payment updates.'],
] as const;
const accessibilityOptions = [
  ['largeText', 'Larger text', 'Increase text size throughout the app.'],
  ['highContrast', 'High contrast', 'Strengthen text and interface contrast.'],
  ['reducedMotion', 'Reduced motion', 'Reduce non-essential interface animation.'],
] as const;

function latestEntitlement(history: MembershipHistory | null): Entitlement | null {
  const all = [...(history?.memberships ?? []), ...(history?.passes ?? [])];
  return all.find((item) => item.effectiveStatus === 'active') ?? all[0] ?? null;
}

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const {
    preferences,
    loading: preferencesLoading,
    error: preferencesError,
    save: savePreferences,
    reload: reloadPreferences,
  } = useAccountPreferences();
  const history = useApi<MembershipHistory>('/me/memberships');
  const payments = useApi<Page<Payment>>('/me/payments?offset=0');
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceNotice, setPreferenceNotice] = useState('');
  const entitlement = latestEntitlement(history.data);
  const latestPayment = payments.data?.items[0];

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
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

  const updatePreference = async (
    group: 'notifications' | 'accessibility',
    key: keyof AccountPreferences['notifications'] | keyof AccountPreferences['accessibility'],
    checked: boolean,
  ) => {
    setPreferenceBusy(true);
    setPreferenceNotice('');
    try {
      await savePreferences({ [group]: { [key]: checked } });
      setPreferenceNotice('Your settings were saved.');
    } catch {
      // The shared preference context retains and displays the request error.
    } finally {
      setPreferenceBusy(false);
    }
  };

  return (
    <div className="account-settings page-enter">
      <h1 className="account-settings__title">User Settings</h1>
      <div className="account-settings__grid">
        <section className="account-card account-card--personal" aria-labelledby="account-personal-title">
          <div className="account-card__heading">
            <h2 id="account-personal-title">Personal Details</h2>
            <Pencil aria-hidden="true" />
          </div>
          <form className="account-profile-form" onSubmit={saveProfile}>
            <div className="account-profile-form__identity">
              <div className="account-avatar" aria-hidden="true">
                {user?.firstName?.at(0)}{user?.lastName?.at(0)}
              </div>
              <button className="account-photo-placeholder" type="button" disabled title="Photo upload is not available yet">
                <ImagePlus aria-hidden="true" /> Add image <span>(coming soon)</span>
              </button>
            </div>
            <label className="account-field">
              <span>First name</span>
              <input name="firstName" defaultValue={user?.firstName ?? ''} required maxLength={50} autoComplete="given-name" />
            </label>
            <label className="account-field">
              <span>Last name</span>
              <input name="lastName" defaultValue={user?.lastName ?? ''} required maxLength={50} autoComplete="family-name" />
            </label>
            <label className="account-field">
              <span>Email address</span>
              <input type="email" value={user?.email ?? ''} readOnly />
            </label>
            <label className="account-field">
              <span>Phone number</span>
              <input name="phone" type="tel" defaultValue={user?.phone ?? ''} required maxLength={15} autoComplete="tel" />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="button button--primary account-card__action" type="submit" disabled={busy}>
              <Check aria-hidden="true" /> {busy ? 'Saving…' : 'Save details'}
            </button>
          </form>
        </section>

        <section className="account-card account-card--membership" aria-labelledby="account-membership-title">
          <div className="account-card__heading"><h2 id="account-membership-title">Membership</h2></div>
          {history.loading ? <p role="status">Loading membership…</p> : null}
          {history.error ? <p className="form-error" role="alert">{history.error}</p> : null}
          {history.data ? (
            <>
              <p className="account-card__lead">Facility access</p>
              <p><span className={`account-status account-status--${history.data.accessStatus}`}>{history.data.accessStatus}</span></p>
              {entitlement ? (
                <div className="account-summary">
                  <strong>{entitlement.plan?.name ?? (entitlement.validDate ? 'Day pass' : 'Membership')}</strong>
                  <span>{entitlement.effectiveStatus}</span>
                  <small>{entitlement.validDate ? `Valid ${entitlement.validDate}` : entitlement.endsAt ? `Through ${new Date(entitlement.endsAt).toLocaleDateString()}` : 'Dates not available'}</small>
                </div>
              ) : <p>No current membership or day pass.</p>}
              <Link className="account-card__link" to="/membership">Membership details <ExternalLink aria-hidden="true" /></Link>
            </>
          ) : null}
        </section>

        <section className="account-card account-card--notifications" aria-labelledby="account-notifications-title">
          <div className="account-card__heading"><h2 id="account-notifications-title">Notification Settings</h2><Bell aria-hidden="true" /></div>
          <fieldset className="account-toggle-list" disabled={preferencesLoading || preferenceBusy}>
            <legend className="visually-hidden">Email notification preferences</legend>
            {notificationOptions.map(([key, label, description]) => (
              <label className="account-toggle" key={key}>
                <span><strong>{label}</strong><small>{description}</small></span>
                <input type="checkbox" checked={preferences.notifications[key]} onChange={(event) => void updatePreference('notifications', key, event.currentTarget.checked)} />
              </label>
            ))}
          </fieldset>
          <p className="account-card__note">Saved email preferences for studio notices. Email delivery is not configured in this version.</p>
        </section>

        <section className="account-card account-card--accessibility" aria-labelledby="account-accessibility-title">
          <div className="account-card__heading"><h2 id="account-accessibility-title">Accessibility</h2><Accessibility aria-hidden="true" /></div>
          <fieldset className="account-toggle-list" disabled={preferencesLoading || preferenceBusy}>
            <legend className="visually-hidden">Accessibility preferences</legend>
            {accessibilityOptions.map(([key, label, description]) => (
              <label className="account-toggle" key={key}>
                <span><strong>{label}</strong><small>{description}</small></span>
                <input type="checkbox" checked={preferences.accessibility[key]} onChange={(event) => void updatePreference('accessibility', key, event.currentTarget.checked)} />
              </label>
            ))}
          </fieldset>
        </section>

        <section className="account-card account-card--payments" aria-labelledby="account-payments-title">
          <div className="account-card__heading"><h2 id="account-payments-title">Payments</h2><CreditCard aria-hidden="true" /></div>
          {payments.loading ? <p role="status">Loading payment history…</p> : null}
          {payments.error ? <p className="form-error" role="alert">{payments.error}</p> : null}
          {payments.data ? (
            <>
              {latestPayment ? (
                <div className="account-payment-summary">
                  <div><strong>{latestPayment.planName}</strong><span>{dollars(latestPayment.amount)}</span></div>
                  <p>Recorded payment · {latestPayment.status.replaceAll('_', ' ')}</p>
                </div>
              ) : <p>No recorded payments yet.</p>}
              <p className="account-card__note">Payments are recorded by studio staff; this app does not store card details or process charges.</p>
              <Link className="account-card__link" to="/membership">View payment history <ExternalLink aria-hidden="true" /></Link>
            </>
          ) : null}
        </section>
      </div>

      {preferencesError ? (
        <div className="account-settings__feedback" role="alert">
          <span>{preferencesError}</span>
          <button className="text-button" type="button" onClick={() => void reloadPreferences()}>Retry loading settings</button>
        </div>
      ) : null}
      {preferenceNotice ? <p className="account-settings__feedback" role="status">{preferenceNotice}</p> : null}
      <section className="account-contact" aria-labelledby="account-contact-title">
        <h2 id="account-contact-title">Contact The Crafty Studio</h2>
        <p>Studio email address to be confirmed.</p>
      </section>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
