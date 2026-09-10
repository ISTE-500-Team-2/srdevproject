import { Bell, CreditCard, LockKeyhole, Save, ShieldCheck, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Toast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';

export function ProfilePage() {
  const { user } = useAuth();
  const [section, setSection] = useState('personal');
  const [toast, setToast] = useState<string | null>(null);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setToast('Profile preferences saved locally.');
    window.setTimeout(() => setToast(null), 2600);
  };

  return (
    <div className="profile-page page-enter">
      <section className="profile-hero">
        <div className="profile-hero__avatar">{user?.firstName.at(0)}{user?.lastName.at(0)}</div>
        <div><p className="eyebrow">Account</p><h1>{user?.firstName} {user?.lastName}</h1><span>{user?.membership} · {user?.role}</span></div>
      </section>
      <div className="profile-layout">
        <nav className="profile-nav" aria-label="Account sections">
          <button className={section === 'personal' ? 'is-active' : ''} onClick={() => setSection('personal')}><UserRound aria-hidden="true" /> Personal information</button>
          <button className={section === 'security' ? 'is-active' : ''} onClick={() => setSection('security')}><LockKeyhole aria-hidden="true" /> Security & privacy</button>
          <button className={section === 'membership' ? 'is-active' : ''} onClick={() => setSection('membership')}><CreditCard aria-hidden="true" /> Membership</button>
          <button className={section === 'notifications' ? 'is-active' : ''} onClick={() => setSection('notifications')}><Bell aria-hidden="true" /> Notifications</button>
        </nav>
        <section className="profile-panel panel">
          <form onSubmit={save}>
            <p className="eyebrow">Prototype settings</p>
            <h2>{section === 'personal' ? 'Personal information' : section === 'security' ? 'Security & privacy' : section === 'membership' ? 'Membership details' : 'Notification settings'}</h2>
            {section === 'personal' ? <div className="two-column-fields"><label className="form-field"><span>First name</span><input defaultValue={user?.firstName} /></label><label className="form-field"><span>Last name</span><input defaultValue={user?.lastName} /></label><label className="form-field form-field--wide"><span>Email</span><input type="email" defaultValue={user?.email} /></label><label className="form-field form-field--wide"><span>Phone</span><input type="tel" placeholder="(555) 555-5555" /></label></div> : null}
            {section === 'security' ? <div className="profile-callout"><ShieldCheck aria-hidden="true" /><div><strong>Your prototype session is protected</strong><p>Production authentication will use short-lived access tokens and HttpOnly refresh cookies.</p></div></div> : null}
            {section === 'membership' ? <div className="membership-detail"><span>Current plan</span><strong>{user?.membership}</strong><p>Basic tools are included. Premium equipment and studio time are billed separately.</p><button type="button" className="button button--quiet">Compare plans</button></div> : null}
            {section === 'notifications' ? <div className="preference-list"><label><input type="checkbox" defaultChecked /><span>Reservation confirmations</span></label><label><input type="checkbox" defaultChecked /><span>Certification reminders</span></label><label><input type="checkbox" /><span>New class announcements</span></label></div> : null}
            <button className="button button--primary" type="submit"><Save aria-hidden="true" /> Save changes</button>
          </form>
        </section>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
