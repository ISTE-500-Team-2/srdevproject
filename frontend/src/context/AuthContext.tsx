import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, errorMessage, setCsrfToken, setAccessToken } from '../lib/api';
import type { NotificationMessage, Registration, Session, User } from '../lib/contracts';
import type { UserRole } from '../types';
import { forgetRecentAccounts } from '../lib/recentAccounts';
import { loadShared } from '../lib/useApi';


interface AuthContextValue {
  /** Whose account the app is showing (an opened member account while staff act for them). */
  user: User | null;
  /** The staff member who opened `user`'s account; null outside account mode. */
  actor: User | null;
  notification: NotificationMessage | null;
  loading: boolean;
  error: string;
  demoLogin: boolean;
  /** True after an explicit sign-out (until the next sign-in), unlike an expired session. */
  signedOut: boolean;
  login: (
    email: string,
    password: string,
    remember: boolean,
  ) => Promise<UserRole>;
  loginAs: (role: UserRole) => Promise<UserRole>;
  register: (input: Registration) => Promise<{confirmationRequired:true;email:string;emailSendingEnabled:boolean}>;
  confirmEmail: (token:string) => Promise<UserRole>;
  logout: () => Promise<void>;
  /**
   * Re-read `/auth/session`. Joins a read already in flight for the same router
   * location unless an auth transition happened since it started (this collapses
   * the provider's and the guard's startup checks). Pass `{ fresh: true }` after a
   * write so the response reflects it, and for tab returns, which must revalidate anew.
   */
  refresh: (blocking?: boolean, options?: { fresh?: boolean }) => Promise<void>;
  openAccount: (userId: number) => Promise<void>;
  closeAccount: () => Promise<void>;
  clearNotification: () => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [actor, setActor] = useState<User | null>(null);
  const [notification, setNotification] = useState<NotificationMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoLogin, setDemoLogin] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const revision = useRef(0);
  const acceptSession = useCallback((session: Session) => {
    revision.current++;
    setLoading(false);
    setSignedOut(false);
    if (session.accessToken) setAccessToken(session.accessToken);
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setActor(session.actingAs?.actor ?? null);
    if (session.notification) setNotification(session.notification);
    setError('');
    return session.user.role;
  }, []);
  // The router location current for session reads; layout effects run before the
  // guards' passive effects, so a navigation's check always sees its own location.
  const location = useLocation();
  const currentLocation = useRef<object>(location);
  useLayoutEffect(() => { currentLocation.current = location; }, [location]);
  const pending = useRef<{ location: object; revision: number; read: Promise<void> } | null>(null);
  const read = useCallback(async (requestRevision: number) => {
    try {
      const session = await api<Session>('/auth/session');
      if (requestRevision !== revision.current) return;
      // acceptSession advances the revision; loading belongs to this response.
      setLoading(false);
      acceptSession(session);
    } catch (err) {
      if (requestRevision !== revision.current) return;
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setActor(null);
        setCsrfToken(null);
        setAccessToken(null);
      } else setError(errorMessage(err));
    } finally {
      if (pending.current?.revision === requestRevision) pending.current = null;
      if (requestRevision === revision.current) setLoading(false);
    }
  }, [acceptSession]);
  const refresh = useCallback((blocking = false, options?: { fresh?: boolean }) => {
    const inFlight = pending.current;
    // Share a read started at this same router location when nothing (login, logout,
    // account mode, expiry, a newer read) has superseded it; its answer is no older
    // than this location. A read from an earlier location is never reused.
    if (!options?.fresh && inFlight && inFlight.revision === revision.current
      && inFlight.location === currentLocation.current) {
      // The shared read's settlement (or the transition that supersedes it) clears this.
      if (blocking) setLoading(true);
      return inFlight.read;
    }
    const requestRevision = ++revision.current;
    if (blocking) setLoading(true);
    setError('');
    const started = { location: currentLocation.current, revision: requestRevision, read: read(requestRevision) };
    pending.current = started;
    return started.read;
  }, [read]);
  useEffect(() => {
    void refresh();
    // Shared read: pages that need server settings (e.g. Today's time zone) get them without a round trip.
    loadShared<{ demoLogin: boolean }>('/config')
      .then((config) => setDemoLogin(config.demoLogin))
      .catch(() => setDemoLogin(false));
    const expired = () => {
      revision.current++;
      setLoading(false);
      setError('');
      setNotification(null);
      setUser(null);
      setActor(null);
      setCsrfToken(null);
        setAccessToken(null);
    };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [refresh]);
  const login = useCallback(
    async (email: string, password: string, remember: boolean) =>
      acceptSession(
        await api<Session>('/auth/login', {
          method: 'POST',
          body: { email, password, remember },
        }),
      ),
    [acceptSession],
  );
  const loginAs = useCallback(
    async (role: UserRole) =>
      acceptSession(
        await api<Session>('/auth/demo', { method: 'POST', body: { role } }),
      ),
    [acceptSession],
  );
  const register = useCallback(
    async (input: Registration) => api<{confirmationRequired:true;email:string;emailSendingEnabled:boolean}>('/auth/register', {method:'POST',body:{...input,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}}),
    [],
  );
  const confirmEmail = useCallback(async (token:string) => acceptSession(await api<Session>('/auth/confirm',{method:'POST',body:{token}})),[acceptSession]);
  const logout = useCallback(async () => {
    // Invalidate in-flight session reads before and after server revocation.
    revision.current++;
    await api<void>('/auth/logout', { method: 'POST' });
    revision.current++;
    setLoading(false);
    setCsrfToken(null);
        setAccessToken(null);
    // Same render as clearing the user, so the route guard never sees one without the other.
    setSignedOut(true);
    setUser(null);
    setActor(null);
    setNotification(null);
    forgetRecentAccounts();
  }, []);
  const openAccount = useCallback(async (userId: number) => {
    acceptSession(await api<Session>('/admin/account-mode', { method: 'POST', body: { userId } }));
  }, [acceptSession]);
  const closeAccount = useCallback(async () => {
    acceptSession(await api<Session>('/admin/account-mode/end', { method: 'POST' }));
  }, [acceptSession]);
  const clearNotification = useCallback(() => {
    setNotification(null);
  }, []);
  const value = useMemo(
    () => ({
      user,
      actor,
      notification,
      loading,
      error,
      demoLogin,
      signedOut,
      login,
      loginAs,
      register,
      confirmEmail,
      logout,
      refresh,
      openAccount,
      closeAccount,
      clearNotification,
    }),
    [
      user,
      actor,
      notification,
      loading,
      error,
      demoLogin,
      signedOut,
      login,
      loginAs,
      register,
      confirmEmail,
      logout,
      refresh,
      openAccount,
      closeAccount,
      clearNotification,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
