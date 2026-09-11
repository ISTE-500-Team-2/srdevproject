import { Outlet } from 'react-router-dom';
import { Footer } from './Footer';
import { Header } from './Header';
import { useAuth } from '../context/AuthContext';

export function AppShell() {
  const { demoLogin } = useAuth();
  return (
    <div className="app-shell">
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
