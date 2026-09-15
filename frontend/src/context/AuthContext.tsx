import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage, setCsrfToken, setAccessToken } from '../lib/api';
import type { Registration, Session, User } from '../lib/contracts';
import type { UserRole } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string;
  demoLogin: boolean;
  login: (
    email: string,
    password: string,
    remember: boolean,
  ) => Promise<UserRole>;
  loginAs: (role: UserRole) => Promise<UserRole>;
  register: (input: Registration) => Promise<UserRole>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoLogin, setDemoLogin] = useState(false);
  const acceptSession = useCallback((session: Session) => {
    if (session.accessToken) setAccessToken(session.accessToken);
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setError('');
    return session.user.role;
  }, []);
  const refresh = useCallback(async () => {
    setError('');
    try {
      acceptSession(await api<Session>('/auth/session'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setCsrfToken(null);
        setAccessToken(null);
      } else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [acceptSession]);
  useEffect(() => {
    void refresh();
    api<{ demoLogin: boolean }>('/config')
      .then((config) => setDemoLogin(config.demoLogin))
      .catch(() => setDemoLogin(false));
    const expired = () => {
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
    async (input: Registration) =>
      acceptSession(
        await api<Session>('/auth/register', { method: 'POST', body: input }),
      ),
    [acceptSession],
  );
  const logout = useCallback(async () => {
    await api<void>('/auth/logout', { method: 'POST' });
    setCsrfToken(null);
        setAccessToken(null);
    setUser(null);
  }, []);
  const value = useMemo(
    () => ({
      user,
      loading,
      error,
      demoLogin,
      login,
      loginAs,
      register,
      logout,
      refresh,
    }),
    [
      user,
      loading,
      error,
      demoLogin,
      login,
      loginAs,
      register,
      logout,
      refresh,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
