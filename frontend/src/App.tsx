import { CheckoutReturn } from './components/CheckoutReturn';
import { TrainingPage } from './pages/TrainingPage';
import { StudiosPage } from './pages/StudiosPage';
import { RequireUser, RequireStaff, isWorkspaceUser } from './components/RouteGuards';
import { AdminShell } from './components/admin/AdminShell';
import { AdminIndex, AdminSectionPage } from './pages/admin/AdminSectionPage';
import { adminSections } from './pages/admin/sections';
import { AccountHomePage } from './pages/AccountHomePage';
import { useAuth } from './context/AuthContext';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ConfirmEmailPage } from './pages/ConfirmEmailPage';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './context/AuthContext';
import { PageTitle } from './components/PageTitle';
import type { ReactNode } from 'react';
import { CertificationsPage } from './pages/CertificationsPage';
import { ClassesPage } from './pages/ClassesPage';
import { LoadingPage } from './pages/LoadingPage';
import { LoginPage } from './pages/LoginPage';
import { MemberHomePage } from './pages/MemberHomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { EquipmentPage } from './pages/EquipmentPage';
import { MembershipPage } from './pages/MembershipPage';
import './management.css';
import './admin.css';

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

/** Each page names its browser tab, e.g. "Membership · The Collaboratory". */
const titled = (title: string, page: ReactNode) => <><PageTitle title={title} />{page}</>;

function LegacyEquipmentRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: '/equipment', search, hash }} />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/reset-password" element={titled('Reset password', <ResetPasswordPage />)} />
        <Route path="/confirm-email" element={titled('Confirm email', <ConfirmEmailPage />)} />
        <Route path="/login" element={titled('Login', <LoginPage />)} />
        <Route path="/loading" element={titled('Loading', <LoadingPage />)} />
        <Route element={<RequireUser />}>
          <Route path="checkout-return" element={titled('Checkout', <CheckoutReturn />)} />
          <Route element={<RequireStaff />}>
            <Route path="admin" element={<AdminShell />}>
              <Route index element={titled('Today', <AdminIndex />)} />
              {adminSections.map((section) => (
                <Route key={section.path} path={section.path === 'equipment' ? 'equipment/:equipmentId?' : section.path} element={titled(section.label, <AdminSectionPage section={section} />)} />
              ))}
              <Route path="*" element={<Navigate replace to="/admin" />} />
            </Route>
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
    </AuthProvider>
  );
}
