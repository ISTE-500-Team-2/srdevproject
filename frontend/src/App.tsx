import { Component, lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RequireUser, RequireStaff, isWorkspaceUser } from './components/RouteGuards';
import { useAuth, AuthProvider } from './context/AuthContext';
import { titled } from './components/PageTitle';
import { LoadingPage } from './pages/LoadingPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { loadMemberArea, loadStaffArea, preloadAreaFor, preloadMemberArea, preloadStaffArea, type AreaLoader } from './areas/load';

// The login page and app frame load first; the member site and the staff
// workspace are separate downloads, started as soon as it is clear which one
// is needed (see areas/load.ts and AreaPreloader).
/** A component from a lazily loaded area: rendered directly once that area has arrived. */
function fromArea<M>(area: AreaLoader<M>, pick: (module: M) => ComponentType<{ children?: ReactNode }>) {
  const Pending = lazy(() => area().then((module) => ({ default: pick(module) })));
  return function AreaComponent(props: { children?: ReactNode }) {
    const module = area.loaded();
    const Page = module ? pick(module) : Pending;
    return <Page {...props} />;
  };
}
type MemberArea = Awaited<ReturnType<typeof loadMemberArea>>;
const member = <K extends keyof MemberArea>(name: K) =>
  fromArea(loadMemberArea, (area) => area[name] as ComponentType<{ children?: ReactNode }>);
const AppShell = member('AppShell');
const CheckoutReturn = member('CheckoutReturn');
const AccountHomePage = member('AccountHomePage');
const CertificationsPage = member('CertificationsPage');
const ClassesPage = member('ClassesPage');
const EquipmentPage = member('EquipmentPage');
const MemberHomePage = member('MemberHomePage');
const MembershipPage = member('MembershipPage');
const ProfilePage = member('ProfilePage');
const StudiosPage = member('StudiosPage');
const TrainingPage = member('TrainingPage');
const StaffArea = fromArea(loadStaffArea, (area) => area.default);
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const ConfirmEmailPage = lazy(() => import('./pages/ConfirmEmailPage').then((m) => ({ default: m.ConfirmEmailPage })));

/** Starts the right area's download from the URL, and from the role once it is known. */
function AreaPreloader() {
  const { user, actor } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => preloadAreaFor(pathname), [pathname]);
  useEffect(() => {
    if (!user) return;
    if (!isWorkspaceUser(actor ?? user) || actor) { preloadMemberArea(); return; }
    preloadStaffArea();
    // Staff can open the member site (their own or a member's account): fetch it when idle.
    // Members never download the staff workspace.
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1000));
    idle(() => preloadMemberArea());
  }, [user, actor]);
  return null;
}

/** A page's code could not be downloaded (offline, or an older tab after a release). */
export class AreaBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page-shell">
        <p role="alert">This page couldn’t load. Check your connection, then reload.</p>
        <button className="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}

/**
 * Home: staff land in the workspace; with a member's account open, staff see
 * what they can do for that member instead of the member's welcome screen.
 */
export function HomeRoute() {
  const { user, actor } = useAuth();
  if (actor) return <AccountHomePage />;
  if (isWorkspaceUser(user)) return <Navigate replace to="/admin" />;
  return <MemberHomePage />;
}

function LegacyEquipmentRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: '/equipment', search, hash }} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AreaPreloader />
      <AreaBoundary>
      <Suspense fallback={<main className="page-shell" role="status">Loading…</main>}>
      <Routes>
        <Route path="/reset-password" element={titled('Reset password', <ResetPasswordPage />)} />
        <Route path="/confirm-email" element={titled('Confirm email', <ConfirmEmailPage />)} />
        <Route path="/login" element={titled('Login', <LoginPage />)} />
        <Route path="/loading" element={titled('Loading', <LoadingPage />)} />
        <Route element={<RequireUser />}>
          <Route path="checkout-return" element={titled('Checkout', <CheckoutReturn />)} />
          <Route element={<RequireStaff />}>
            <Route path="admin/*" element={<StaffArea />} />
          </Route>
          <Route element={<AppShell />}>
            <Route index element={titled('Home', <HomeRoute />)} />
            <Route path="equipment" element={titled('Equipment', <EquipmentPage />)} />
            <Route path="reservations" element={<LegacyEquipmentRedirect />} />
            <Route path="studios" element={titled('Studios', <StudiosPage />)} />
            <Route path="certifications" element={titled('Certifications', <CertificationsPage />)} />
            <Route path="classes" element={titled('Classes', <ClassesPage />)} />
            <Route path="training" element={titled('Training', <TrainingPage />)} />
            <Route path="profile" element={titled('Profile', <ProfilePage />)} />
            <Route path="membership" element={titled('Membership', <CheckoutReturn><MembershipPage /></CheckoutReturn>)} />
          </Route>
        </Route>
        <Route path="*" element={titled('Page not found', <NotFoundPage />)} />
      </Routes>
      </Suspense>
      </AreaBoundary>
    </AuthProvider>
  );
}
