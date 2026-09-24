import { RequireUser, RequireStaff } from './components/RouteGuards';
import { ConfirmEmailPage } from './pages/ConfirmEmailPage';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './context/AuthContext';
import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { CertificationsPage } from './pages/CertificationsPage';
import { ClassesPage } from './pages/ClassesPage';
import { LoadingPage } from './pages/LoadingPage';
import { LoginPage } from './pages/LoginPage';
import { MemberHomePage } from './pages/MemberHomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { ReservationsPage } from './pages/ReservationsPage';
import { MembershipPage } from './pages/MembershipPage';
import './management.css';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/loading" element={<LoadingPage />} />
        <Route element={<RequireUser />}>
          <Route element={<AppShell />}>
            <Route index element={<MemberHomePage />} />
            <Route path="reservations" element={<ReservationsPage />} />
            <Route path="certifications" element={<CertificationsPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="membership" element={<MembershipPage />} />
            <Route element={<RequireStaff />}>
              <Route path="admin" element={<AdminDashboardPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
