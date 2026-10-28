import {
  Check, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Mail, MailCheck, ShieldCheck,
} from 'lucide-react';
import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ClickSpark from '../components/reactbits/ClickSpark';
import { api, ApiError, errorMessage } from '../lib/api';

const SplitText = lazy(() => import('../components/reactbits/SplitText'));
const SPARK_COLORS = ['#f7961d', '#ffb54d', '#ffdba5', '#a86008'];
const RESEND_SECONDS = 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
type View = 'request' | 'sent' | 'reset' | 'done' | 'expired';

// Mirrors newPasswordField in backend/src/domain.ts.
const RULES = [
  { key: 'len', label: '8–128 characters', test: (p: string) => p.length >= 8 && p.length <= 128 },
  { key: 'upper', label: 'One uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { key: 'special', label: 'One special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState(() => location.hash.slice(1));
  const [linkVersion, setLinkVersion] = useState(0);
  const lastHash = useRef(location.hash);
  const [view, setView] = useState<View>(() => location.hash ? TOKEN.test(token) ? 'reset' : 'expired' : 'request');
  const [email, setEmail] = useState<string>(location.state?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(() => TOKEN.test(token));
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  const submitting = useRef(false);
  const resendAt = useRef(0);
  const operation = useRef(0);

  // Fragment is not sent to the web server; remove it after capturing to keep it out of history.
  useEffect(() => {
    if (!location.hash) { lastHash.current = ''; return; }
    // Pasting an emailed link into this same tab can be a fragment-only navigation.
    // Capture that link too, and ignore any response from the previous form.
    operation.current++;
    submitting.current = false;
    setBusy(false);
    const next = location.hash.slice(1);
    setToken(next);
    // Browser hash navigation can retain history.state (and the router key), even
    // when reopening the same consumed link. A fresh fragment always rechecks it.
    if (lastHash.current !== location.hash) setLinkVersion(value => value + 1);
    lastHash.current = location.hash;
    setView(TOKEN.test(next) ? 'reset' : 'expired');
    setChecking(TOKEN.test(next));
    setPassword('');
    setConfirm('');
    setReveal(false);
    setError('');
    setEmailError('');
    navigate('/reset-password', { replace: true });
  }, [location.hash, location.key, navigate]);

  useEffect(() => {
    if (!TOKEN.test(token)) return;
    const controller = new AbortController();
    void api('/auth/password-reset/check', { method: 'POST', body: { token }, signal: controller.signal })
      .catch(err => {
        if (controller.signal.aborted) return;
        // Only a rejected token is expired; throttling or outages keep the form and say why.
        if (err instanceof ApiError && err.code === 'RESET_INVALID') setView('expired');
        else setError(errorMessage(err));
      })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [token, linkVersion]);

  useEffect(() => {
    if (previousView.current !== view) headingRef.current?.focus();
    previousView.current = view;
  }, [view]);

  const coolingDown = cooldown > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const interval = window.setInterval(() => {
      setCooldown(Math.max(0, Math.ceil((resendAt.current - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [coolingDown]);

  async function sendLink(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (submitting.current || (view === 'sent' && cooldown > 0)) return;
    const address = email.trim();
    if (!address || !/^\S+@\S+\.\S+$/.test(address)) {
      setEmailError(address ? 'That doesn’t look like an email address.' : 'Enter the email on your account.');
      return;
    }
    submitting.current = true;
    const currentOperation = ++operation.current;
    setBusy(true);
    setError('');
    try {
      await api('/auth/password-reset', { method: 'POST', body: { email: address } });
      if (currentOperation !== operation.current) return;
      setEmail(address);
      resendAt.current = Date.now() + RESEND_SECONDS * 1000;
      setCooldown(RESEND_SECONDS);
      setView('sent');
    } catch (err) {
      if (currentOperation === operation.current) setError(errorMessage(err));
    } finally {
      if (currentOperation === operation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || checking) return;
    if (!RULES.every(rule => rule.test(password)) || password !== confirm) {
      setError('Your password doesn’t meet every requirement yet.');
      return;
    }
    submitting.current = true;
    const currentOperation = ++operation.current;
    setBusy(true);
    setError('');
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      if (currentOperation !== operation.current) return;
      setPassword('');
      setConfirm('');
      setView('done');
    } catch (err) {
      if (currentOperation !== operation.current) return;
      if (err instanceof ApiError && err.status === 400 && err.code === 'RESET_INVALID') setView('expired');
      else setError(errorMessage(err));
    } finally {
      if (currentOperation === operation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  function requestAgain() {
    setError('');
    setEmailError('');
    setPassword('');
    setConfirm('');
    setView('request');
  }

  const dots = view === 'request' ? 1 : view === 'sent' ? 2 : view === 'reset' ? 3 : 0;
  const title = { request: 'Reset password', sent: 'Check your email', reset: 'New password', done: 'You’re all set', expired: 'Link expired' }[view];
  const body = {
    request: 'Enter the email on your account and we’ll send you a link to set a new one.',
    sent: <>If an account uses <span className="reset-email">{email}</span>, a reset link is on its way. It expires in 30 minutes.</>,
    reset: 'Choose a password you haven’t used here before.',
    done: 'Your password is updated. For safety, we signed you out on your other devices.',
    expired: 'Reset links work once and expire after 30 minutes. Send yourself a fresh one.',
  }[view];
  const lead = view === 'sent' ? 'All done?' : view === 'reset' ? 'Changed your mind?' : 'Remembered it?';
  const primary = (label: string, busyLabel: string, onClick?: () => void) => (
    <ClickSpark sparkColor={SPARK_COLORS} sparkCount={12} sparkRadius={34} sparkSize={12}
      duration={520} gravity={0.6} randomness={0.6} style={{ height: 'auto' }}>
      <button className="button button--primary button--wide" type={onClick ? 'button' : 'submit'}
        disabled={busy || (view === 'reset' && checking)} onClick={onClick}>
        {checking && view === 'reset' ? 'Checking link…' : busy
          ? <><LoaderCircle className="spin" aria-hidden="true" />{busyLabel}</> : label}
      </button>
    </ClickSpark>
  );

  return (
    <main className="login-page" id="main-content">
      <div className="login-page__ambient login-page__ambient--one" aria-hidden="true" />
      <div className="login-page__ambient login-page__ambient--two" aria-hidden="true" />
      <section className="login-page__content" aria-labelledby="reset-title">
        <img className="login-page__logo" src="/assets/collaboratory-logo.webp" alt="The Collaboratory, White Hall, Maryland" />
        <div className="login-card">
          <div className="reset-step" key={view}>
            <div className="login-card__heading">
              {dots > 0 && <ol className="reset-progress" aria-label={`Step ${dots} of 3`}>
                {[1, 2, 3].map(i => <li key={i} className="reset-progress__dot"
                  data-status={i < dots ? 'complete' : i === dots ? 'active' : 'upcoming'} />)}
              </ol>}
              {view === 'sent' && <div className="reset-medallion" aria-hidden="true"><MailCheck /></div>}
              {view === 'done' && <div className="reset-medallion reset-medallion--done" aria-hidden="true"><ShieldCheck /></div>}
              {view === 'expired' && <div className="reset-medallion reset-medallion--error" aria-hidden="true"><CircleAlert /></div>}
              <p className="eyebrow">Member portal</p>
              <h1 id="reset-title" ref={headingRef} tabIndex={-1}>
                <Suspense fallback={title}><SplitText tag="span" text={title} trigger="load" delay={70} duration={0.9} /></Suspense>
              </h1>
              <p>{body}</p>
            </div>

            {view === 'request' && <form onSubmit={sendLink} noValidate>
              <label className="form-field" data-invalid={emailError ? '' : undefined}>
                <span id="reset-email-label">Email</span>
                <span className="form-field__control">
                  <Mail aria-hidden="true" />
                  <input type="email" value={email} onChange={event => { setEmail(event.target.value); setEmailError(''); }}
                    autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="Enter your account email…"
                    aria-labelledby="reset-email-label" aria-invalid={!!emailError} aria-describedby={emailError ? 'reset-email-error' : undefined} />
                </span>
                {emailError && <p className="form-field__error" id="reset-email-error" role="alert">{emailError}</p>}
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              {primary('Send reset link', 'Sending…')}
            </form>}

            {view === 'sent' && <div className="reset-actions">
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="button button--quiet button--wide" type="button" disabled={cooldown > 0 || busy} onClick={() => void sendLink()}>
                {cooldown > 0 ? <>Resend link in <span className="reset-countdown">{Math.floor(cooldown / 60)}:{String(cooldown % 60).padStart(2, '0')}</span></>
                  : <><Mail aria-hidden="true" />{busy ? 'Sending…' : 'Resend link'}</>}
              </button>
              <p className="reset-hint">Not there? Check spam, or{' '}
                <button className="text-button" type="button" disabled={busy} onClick={requestAgain}>use a different email</button>.
              </p>
            </div>}

            {view === 'reset' && <form onSubmit={savePassword} noValidate>
              <label className="form-field" htmlFor="reset-password">
                <span id="reset-password-label">New password</span>
                <span className="form-field__control">
                  <LockKeyhole aria-hidden="true" />
                  <input id="reset-password" value={password} onChange={event => setPassword(event.target.value)}
                    type={reveal ? 'text' : 'password'} autoComplete="new-password" placeholder="Create a password…"
                    maxLength={128} aria-labelledby="reset-password-label" aria-describedby="reset-rules" />
                  <button className="form-field__reveal" type="button" onClick={() => setReveal(value => !value)}
                    aria-label={reveal ? 'Hide password' : 'Show password'}>
                    {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </span>
                <ul className="reset-rules" id="reset-rules" aria-live="polite">
                  {[...RULES.map(rule => ({ key: rule.key, label: rule.label, met: rule.test(password) })),
                    { key: 'match', label: 'Passwords match', met: password.length > 0 && password === confirm }].map(rule => (
                    <li key={rule.key} data-met={rule.met ? '' : undefined}>
                      <span className="reset-rules__mark"><Check aria-hidden="true" /></span>
                      {rule.label}<span className="sr-only">{rule.met ? ' (met)' : ' (not met)'}</span>
                    </li>
                  ))}
                </ul>
              </label>
              <label className="form-field">
                <span>Confirm password</span>
                <span className="form-field__control">
                  <KeyRound aria-hidden="true" />
                  <input value={confirm} onChange={event => setConfirm(event.target.value)} type={reveal ? 'text' : 'password'}
                    autoComplete="new-password" placeholder="Type it again…" maxLength={128} />
                  <span />
                </span>
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              {primary('Save password', 'Saving…')}
            </form>}

            {view === 'done' && primary('Go to login', '', () => navigate('/login'))}
            {view === 'expired' && primary('Send a new link', '', requestAgain)}
            {view !== 'done' && <p className="login-card__signup">{lead}{' '}
              <button className="text-button" type="button" onClick={() => navigate('/login')}>Back to login</button>
            </p>}
          </div>
        </div>
      </section>
    </main>
  );
}
