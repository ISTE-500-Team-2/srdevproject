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

function LegacyEquipmentRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: '/equipment', search, hash }} />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/loading" element={<LoadingPage />} />
        <Route element={<RequireUser />}>
          <Route element={<RequireStaff />}>
            <Route path="admin" element={<AdminShell />}>
              <Route index element={<AdminIndex />} />
              {adminSections.map((section) => (
                <Route key={section.path} path={section.path === 'equipment' ? 'equipment/:equipmentId?' : section.path} element={<AdminSectionPage section={section} />} />
              ))}
              <Route path="*" element={<Navigate replace to="/admin" />} />
            </Route>
          </Route>
          <Route element={<AppShell />}>
            <Route index element={<HomeRoute />} />
            <Route path="equipment" element={<EquipmentPage />} />
            <Route path="reservations" element={<LegacyEquipmentRedirect />} />
            <Route path="studios" element={<StudiosPage />} />
            <Route path="certifications" element={<CertificationsPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="training" element={<TrainingPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="membership" element={<MembershipPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
