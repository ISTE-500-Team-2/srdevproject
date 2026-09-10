import { Eye, EyeOff, LockKeyhole, Mail, UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import type { UserRole } from '../types';

export function LoginPage() {
  const { login, loginAs } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'forgot' | 'signup' | null>(null);

  const continueAs = (role: UserRole) => {
    loginAs(role);
    navigate(`/loading?next=${role === 'admin' ? '/admin' : '/'}`);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifier.trim() || !password.trim()) {
      setError('Enter both your email and password to continue.');
      return;
    }
    setError('');
    const role = login(identifier);
    if (!remember) window.sessionStorage.setItem('collaboratory-session-only', 'true');
    navigate(`/loading?next=${role === 'admin' ? '/admin' : '/'}`);
  };

  return (
    <main className="login-page" id="main-content">
      <div className="login-page__ambient login-page__ambient--one" aria-hidden="true" />
      <div className="login-page__ambient login-page__ambient--two" aria-hidden="true" />
      <section className="login-page__content" aria-labelledby="login-title">
        <img
          className="login-page__logo"
          src="/assets/collaboratory-logo.webp"
          alt="The Collaboratory, White Hall, Maryland"
        />
        <div className="login-card">
          <div className="login-card__heading">
            <p className="eyebrow">Member portal</p>
            <h1 id="login-title">Login</h1>
            <p>Pick up where your last project left off.</p>
          </div>
          <form onSubmit={handleSubmit} noValidate>
            <label className="form-field">
              <span>Email Address / Username</span>
              <span className="form-field__control">
                <Mail aria-hidden="true" />
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  placeholder="Enter your email or username…"
                />
              </span>
            </label>

            <label className="form-field">
              <span>Password</span>
              <span className="form-field__control">
                <LockKeyhole aria-hidden="true" />
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter your password…"
                />
                <button
                  className="form-field__reveal"
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </span>
            </label>

            <div className="login-card__options">
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span aria-hidden="true" />
                Remember me
              </label>
              <button className="text-button" type="button" onClick={() => setDialog('forgot')}>
                Forgot password?
              </button>
            </div>

            {error ? <p className="form-error" role="alert">{error}</p> : null}

            <button className="button button--primary button--wide" type="submit">Login</button>
          </form>

          <p className="login-card__signup">
            Don’t have an account?{' '}
            <button className="text-button" type="button" onClick={() => setDialog('signup')}>Sign up</button>
          </p>

          <div className="prototype-access" aria-label="Prototype shortcuts">
            <span>Prototype shortcuts</span>
            <button type="button" onClick={() => continueAs('member')}>Member demo</button>
            <button type="button" onClick={() => continueAs('admin')}>Admin demo</button>
          </div>
        </div>
      </section>

      <Modal open={dialog === 'forgot'} title="Reset your password" onClose={() => setDialog(null)} width="compact">
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); setDialog(null); }}>
          <p>Enter your account email and we’ll send a prototype reset link.</p>
          <label className="form-field">
            <span>Email address</span>
            <span className="form-field__control">
              <Mail aria-hidden="true" />
              <input type="email" placeholder="you@example.com" required />
            </span>
          </label>
          <button className="button button--primary" type="submit">Send reset link</button>
        </form>
      </Modal>

      <Modal open={dialog === 'signup'} title="Create your account" onClose={() => setDialog(null)}>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            continueAs('member');
          }}
        >
          <p>This prototype demonstrates the account-creation flow with local mock data.</p>
          <div className="two-column-fields">
            <label className="form-field"><span>First name</span><input required placeholder="First name" /></label>
            <label className="form-field"><span>Last name</span><input required placeholder="Last name" /></label>
          </div>
          <label className="form-field"><span>Email</span><input type="email" required placeholder="you@example.com" /></label>
          <label className="form-field"><span>Password</span><input type="password" required minLength={8} placeholder="At least 8 characters" /></label>
          <button className="button button--primary" type="submit"><UserPlus aria-hidden="true" /> Create account</button>
        </form>
      </Modal>
    </main>
  );
}
