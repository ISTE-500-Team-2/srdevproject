import { Eye, EyeOff, LockKeyhole, Mail, UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import type { UserRole } from '../types';
import { errorMessage } from '../lib/api';

export function LoginPage() {
  const { login, loginAs, register, demoLogin, loading } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'forgot' | 'signup' | null>(null);
  const [busy, setBusy] = useState(false);

  const continueAs = async (role: UserRole) => {
    setBusy(true);
    setError('');
    try {
      await loginAs(role);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identifier.trim() || !password.trim()) {
      setError('Enter both your email and password to continue.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await login(identifier, password, remember);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      await register({
        firstName: String(form.get('firstName')),
        lastName: String(form.get('lastName')),
        phone: String(form.get('phone')),
        email: String(form.get('email')),
        password: String(form.get('password')),
      });
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page" id="main-content">
      <div
        className="login-page__ambient login-page__ambient--one"
        aria-hidden="true"
      />
      <div
        className="login-page__ambient login-page__ambient--two"
        aria-hidden="true"
      />
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
              <span>Email address</span>
              <span className="form-field__control">
                <Mail aria-hidden="true" />
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  type="email"
                  placeholder="Enter your email…"
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
                  {showPassword ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
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
              <button
                className="text-button"
                type="button"
                onClick={() => setDialog('forgot')}
              >
                Forgot password?
              </button>
            </div>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              className="button button--primary button--wide"
              type="submit"
              disabled={busy || loading}
            >
              {busy ? 'Please wait…' : 'Login'}
            </button>
          </form>

          <p className="login-card__signup">
            Don’t have an account?{' '}
            <button
              className="text-button"
              type="button"
              onClick={() => setDialog('signup')}
            >
              Sign up
            </button>
          </p>

          {demoLogin ? (
            <div
              className="prototype-access"
              aria-label="Development demo accounts"
            >
              <span>Sample accounts · isolated demo data</span>
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void continueAs('member')}
              >
                Member demo
              </button>
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void continueAs('admin')}
              >
                Admin demo
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <Modal
        open={dialog === 'forgot'}
        title="Reset your password"
        onClose={() => setDialog(null)}
        width="compact"
      >
        <p>
          Password reset is not available in this development version. No reset
          email will be sent.
        </p>
      </Modal>

      <Modal
        open={dialog === 'signup'}
        title="Create your account"
        onClose={() => setDialog(null)}
      >
        <form className="stack-form" onSubmit={handleRegister}>
          <p>
            Create your member account. Membership or a day pass must be
            assigned before equipment access.
          </p>
          <div className="two-column-fields">
            <label className="form-field">
              <span>First name</span>
              <input
                name="firstName"
                required
                maxLength={50}
                autoComplete="given-name"
              />
            </label>
            <label className="form-field">
              <span>Last name</span>
              <input
                name="lastName"
                required
                maxLength={50}
                autoComplete="family-name"
              />
            </label>
          </div>
          <label className="form-field">
            <span>Email</span>
            <input
              name="email"
              type="email"
              required
              maxLength={100}
              autoComplete="email"
            />
          </label>
          <label className="form-field">
            <span>Phone</span>
            <input
              name="phone"
              type="tel"
              required
              maxLength={15}
              autoComplete="tel"
            />
          </label>
          <label className="form-field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </label>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || loading}
          >
            <UserPlus aria-hidden="true" />{' '}
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </Modal>
    </main>
  );
}
