import { Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react';
import { type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent, lazy, Suspense, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import ClickSpark from '../components/reactbits/ClickSpark';
import SpringCheck from '../components/reactbits/SpringCheck';
import Stepper, { Step } from '../components/reactbits/Stepper';
import { useAuth } from '../context/AuthContext';
import type { UserRole } from '../types';
import { errorMessage } from '../lib/api';

const SplitText = lazy(() => import('../components/reactbits/SplitText'));

const SPARK_COLORS = ['#f7961d', '#ffb54d', '#ffdba5', '#a86008'];
const STEPPER_THEME = {
  '--stepper-well': 'rgba(113, 91, 78, 0.1)',
  '--stepper-tile': '#fffdfa',
  '--stepper-tile-edge': 'rgba(113, 91, 78, 0.22)',
  '--stepper-ink': 'var(--ink)',
  '--stepper-muted': 'var(--ink-soft)',
  '--stepper-faint': 'var(--border)',
  '--stepper-solid': 'var(--espresso)',
  '--stepper-solid-ink': '#fff',
} as CSSProperties;
const SIGNUP_STEPS = 3;
const EMPTY_SIGNUP = {
  firstName: '',
  lastName: '',
  dob: '',
  email: '',
  phone: '',
  username: '',
  password: '',
};
type SignupField = keyof typeof EMPTY_SIGNUP;

// Sends a server error back to the step that holds the field it names.
const stepForError = (message: string) =>
  /username|password/i.test(message)
    ? 3
    : /email|phone/i.test(message)
      ? 2
      : /name|birth|age/i.test(message)
        ? 1
        : null;

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
  const [signup, setSignup] = useState(EMPTY_SIGNUP);
  const [signupStep, setSignupStep] = useState(1);
  const signupForm = useRef<HTMLFormElement>(null);

  const signupField = (name: SignupField) => ({
    name,
    value: signup[name],
    onChange: (event: ChangeEvent<HTMLInputElement>) =>
      setSignup((current) => ({ ...current, [name]: event.target.value })),
  });

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
      setError('Enter your email or username and password to continue.');
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

  const createAccount = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await register(signup);
      navigate('/confirm-email', {state:{email:result.email,emailSendingEnabled:result.emailSendingEnabled}});
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setSignupStep((current) => stepForError(message) ?? current);
    } finally {
      setBusy(false);
    }
  };

  // Only the visible step's fields are mounted, so validate those before moving on.
  const advanceSignup = () => {
    const pane = signupForm.current?.querySelector(
      '.stepper__pane:not(.stepper__pane--leaving)',
    );
    const invalid = Array.from(pane?.querySelectorAll('input') ?? []).find(
      (input) => !input.checkValidity(),
    );
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    setError('');
    if (signupStep < SIGNUP_STEPS) setSignupStep(signupStep + 1);
    else void createAccount();
  };

  // Enter in any field moves to the next step, like the Continue button.
  const handleSignupKey = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    advanceSignup();
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
            <h1 id="login-title">
              <Suspense fallback="Login">
                <SplitText
                  tag="span"
                  text="Login"
                  trigger="load"
                  delay={70}
                  duration={0.9}
                />
              </Suspense>
            </h1>
            <p>Sign in to book equipment, studios and classes.</p>
          </div>
          <form onSubmit={handleSubmit} noValidate>
            <label className="form-field">
              <span>Email or username</span>
              <span className="form-field__control">
                <Mail aria-hidden="true" />
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  type="text"
                  autoCapitalize="none"
                  spellCheck={false}
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
                  {showPassword ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                </button>
              </span>
            </label>

            <div className="login-card__options">
              <SpringCheck
                className="login-card__remember"
                label="Remember me"
                checked={remember}
                onChange={setRemember}
                strike="none"
                doneOpacity={1}
                color="var(--ink)"
                fillColor="var(--espresso)"
                checkColor="#fff"
                boxSize={20}
                boxRadius={5}
                fontSize={14.4}
              />
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

            <ClickSpark
              sparkColor={SPARK_COLORS}
              sparkCount={12}
              sparkRadius={34}
              sparkSize={12}
              duration={520}
              gravity={0.6}
              randomness={0.6}
              style={{ height: 'auto' }}
            >
              <button
                className="button button--primary button--wide"
                type="submit"
                disabled={busy || loading}
              >
                {busy ? 'Please wait…' : 'Login'}
              </button>
            </ClickSpark>
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
          Online password reset isn't available yet.
        </p>
      </Modal>

      <Modal
        open={dialog === 'signup'}
        title="Create your account"
        onClose={() => setDialog(null)}
      >
        <form
          ref={signupForm}
          className="stack-form signup-form"
          onSubmit={(event) => event.preventDefault()}
          onKeyDown={handleSignupKey}
          noValidate
        >
          <p>
            Create your member account. Membership or a day pass must be
            assigned before equipment access.
          </p>
          <Stepper
            className="signup-stepper"
            step={signupStep}
            onStepChange={setSignupStep}
            linear
            theme="light"
            frame={false}
            width="100%"
            style={STEPPER_THEME}
            completeButtonText={busy ? 'Creating…' : 'Create account'}
            nextButtonProps={{
              disabled: busy || loading,
              onClick: (event) => {
                event.preventDefault();
                advanceSignup();
              },
            }}
          >
            <Step title="About you">
              <div className="signup-step">
                <div className="two-column-fields">
                  <label className="form-field">
                    <span>First name</span>
                    <input
                      {...signupField('firstName')}
                      required
                      maxLength={50}
                      autoComplete="given-name"
                    />
                  </label>
                  <label className="form-field">
                    <span>Last name</span>
                    <input
                      {...signupField('lastName')}
                      required
                      maxLength={50}
                      autoComplete="family-name"
                    />
                  </label>
                </div>
                <label className="form-field">
                  <span>Date of birth</span>
                  <input
                    {...signupField('dob')}
                    type="date"
                    required
                    autoComplete="bday"
                  />
                </label>
              </div>
            </Step>
            <Step title="Contact">
              <div className="signup-step">
                <label className="form-field">
                  <span>Email</span>
                  <input
                    {...signupField('email')}
                    type="email"
                    required
                    maxLength={100}
                    autoComplete="email"
                  />
                </label>
                <label className="form-field">
                  <span>Phone</span>
                  <input
                    {...signupField('phone')}
                    type="tel"
                    required
                    maxLength={15}
                    autoComplete="tel"
                  />
                </label>
              </div>
            </Step>
            <Step title="Sign-in">
              <div className="signup-step">
                <label className="form-field">
                  <span>Username</span>
                  <input
                    {...signupField('username')}
                    aria-label="Username"
                    required
                    minLength={3}
                    maxLength={30}
                    pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,29}"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="signup-username-help"
                  />
                  <small id="signup-username-help">3–30 letters, numbers, periods, underscores or hyphens. Start with a letter or number. You can also sign in with your email.</small>
                </label>
                <label className="form-field">
                  <span>Password</span>
                  <input
                    {...signupField('password')}
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    placeholder="Create a password"
                    aria-describedby="signup-password-requirements"
                  />
                  <small id="signup-password-requirements">
                    8–128 characters with at least one uppercase letter and one special character.
                  </small>
                </label>
              </div>
            </Step>
          </Stepper>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
        </form>
      </Modal>
    </main>
  );
}
