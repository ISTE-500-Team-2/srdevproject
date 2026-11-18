// Persistent member-site header, footer and route outlet, including session notifications.

import { Outlet } from 'react-router-dom';
import { PageErrorBoundary } from './ErrorBoundary';
import { Footer } from './Footer';
import { Header } from './Header';
import { AccountBar } from './admin/AccountBar';
import { useAuth } from '../context/AuthContext';

export function AppShell() {
  const { demoLogin, user } = useAuth();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-shell__header">
        <AccountBar />
        <Header />
      </div>
      {demoLogin ? (
        <div className="sample-data-banner">
          Development demo · sample accounts and equipment · changes are saved
          to the demo database
        </div>
      ) : null}
      <main id="main-content" className="page-shell">
        {/* Built for one open account. When staff open, switch or close a member's
            account (in this tab or another), the page and its data are rebuilt for the
            account now open, so a page loaded for one member never acts for another. */}
        <PageErrorBoundary key={user?.id}>
          <Outlet />
        </PageErrorBoundary>
      </main>
      <Footer />
    </div>
  );
}
