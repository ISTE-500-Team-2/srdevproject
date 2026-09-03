import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { demoUsers } from '../data/mockData';
import type { DemoUser, UserRole } from '../types';

interface AuthContextValue {
  user: DemoUser | null;
  login: (identifier: string) => UserRole;
  loginAs: (role: UserRole) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'collaboratory-demo-role';

function readStoredUser(): DemoUser | null {
  const role = window.localStorage.getItem(STORAGE_KEY);
  return role === 'member' || role === 'admin' ? demoUsers[role] : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(readStoredUser);

  const loginAs = useCallback((role: UserRole) => {
    window.localStorage.setItem(STORAGE_KEY, role);
    setUser(demoUsers[role]);
  }, []);

  const login = useCallback(
    (identifier: string) => {
      const role: UserRole = identifier.toLowerCase().includes('admin') ? 'admin' : 'member';
      loginAs(role);
      return role;
    },
    [loginAs],
  );

  const logout = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, loginAs, logout }), [user, login, loginAs, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
