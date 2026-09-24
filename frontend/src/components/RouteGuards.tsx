import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/** Revalidate before mounting protected content on each navigation or tab return. */
export function RequireUser() {
  const { user, loading, error, refresh } = useAuth();
  const location = useLocation();
  const [checkedLocation, setCheckedLocation] = useState<object | null>(null);
  useEffect(() => {
    let active = true;
    const check = async () => {
      setCheckedLocation(null);
      await refresh(true);
      if (active) setCheckedLocation(location);
    };
    // Keep unsaved forms mounted during background checks; revoked users/roles
    // are removed by the guard as soon as the server response arrives.
    const resume = () => { void refresh(false); };
    const visible = () => { if (document.visibilityState === 'visible') resume(); };
    void check();
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [location, refresh]);
  if (loading || checkedLocation !== location)
    return <main className="page-shell" role="status">Loading your account…</main>;
  if (error)
    return <main className="page-shell"><p role="alert">{error}</p>
      <button className="button" onClick={() => void refresh(true)}>Retry</button></main>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

/** Staff and admins share the workspace; admin-only mutations stay server-enforced. */
export function RequireStaff() {
  const { user } = useAuth();
  if (user?.roles.some(role => role === 'staff' || role === 'admin')) return <Outlet />;
  return <section aria-labelledby="access-denied-title">
    <h1 id="access-denied-title">Access denied</h1>
    <p>This page is available to staff and administrators only.</p>
    <Link className="button" to="/">Return to home</Link>
  </section>;
}
