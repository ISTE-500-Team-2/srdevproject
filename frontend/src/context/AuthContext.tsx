import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage, setCsrfToken, setAccessToken } from '../lib/api';
import type { NotificationMessage, Registration, Session, User } from '../lib/contracts';
import type { UserRole } from '../types';

interface AuthContextValue {
  user: User | null;
  notification: NotificationMessage | null;
  loading: boolean;
  error: string;
  demoLogin: boolean;
  login: (
    email: string,
    password: string,
    remember: boolean,
  ) => Promise<UserRole>;
  loginAs: (role: UserRole) => Promise<UserRole>;
  register: (input: Registration) => Promise<{confirmationRequired:true;email:string;emailSendingEnabled:boolean}>;
  confirmEmail: (token:string) => Promise<UserRole>;
  logout: () => Promise<void>;
  refresh: (blocking?: boolean) => Promise<void>;
  clearNotification: () => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [notification, setNotification] = useState<NotificationMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoLogin, setDemoLogin] = useState(false);
  const revision = useRef(0);
  const acceptSession = useCallback((session: Session) => {
    revision.current++;
    setLoading(false);
    if (session.accessToken) setAccessToken(session.accessToken);
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    if (session.notification) setNotification(session.notification);
    setError('');
    return session.user.role;
  }, []);
  const refresh = useCallback(async (blocking = false) => {
    const requestRevision = ++revision.current;
    if (blocking) setLoading(true);
    setError('');
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
        setCsrfToken(null);
        setAccessToken(null);
      } else setError(errorMessage(err));
    } finally {
      if (requestRevision === revision.current) setLoading(false);
    }
  }, [acceptSession]);
  useEffect(() => {
    void refresh();
    api<{ demoLogin: boolean }>('/config')
      .then((config) => setDemoLogin(config.demoLogin))
      .catch(() => setDemoLogin(false));
    const expired = () => {
      revision.current++;
      setLoading(false);
      setError('');
      setNotification(null);
      setUser(null);
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
    setUser(null);
    setNotification(null);
  }, []);
  const clearNotification = useCallback(() => {
    setNotification(null);
  }, []);
  const value = useMemo(
    () => ({
      user,
      notification,
      loading,
      error,
      demoLogin,
      login,
      loginAs,
      register,
      confirmEmail,
      logout,
      refresh,
      clearNotification,
    }),
    [
      user,
      notification,
      loading,
      error,
      demoLogin,
      login,
      loginAs,
      register,
      confirmEmail,
      logout,
      refresh,
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
