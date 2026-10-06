import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Footer } from './Footer';
import { Header } from './Header';
import { useAuth } from '../context/AuthContext';
import {
  AccountPreferencesProvider,
  useAccountPreferences,
} from '../context/AccountPreferencesContext';

export function AppShell() {
  return (
    <AccountPreferencesProvider>
      <AppShellContent />
    </AccountPreferencesProvider>
  );
}

function AppShellContent() {
  const { demoLogin } = useAuth();
  const { preferences } = useAccountPreferences();
  const accessibility = preferences.accessibility;
  useEffect(() => {
    document.documentElement.classList.toggle(
      'account-settings-large-text',
      accessibility.largeText,
    );
    return () =>
      document.documentElement.classList.remove('account-settings-large-text');
  }, [accessibility.largeText]);
  const className = [
    'app-shell',
    accessibility.largeText && 'app-shell--large-text',
    accessibility.highContrast && 'app-shell--high-contrast',
    accessibility.reducedMotion && 'app-shell--reduced-motion',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Header />
      {demoLogin ? (
        <div className="sample-data-banner">
          Development demo · sample accounts and equipment · changes are saved
          to the demo database
        </div>
      ) : null}
      <main id="main-content" className="page-shell">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
