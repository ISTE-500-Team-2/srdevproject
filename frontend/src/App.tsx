import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { CertificationsPage } from './pages/CertificationsPage';
import { ClassesPage } from './pages/ClassesPage';
import { LoadingPage } from './pages/LoadingPage';
import { LoginPage } from './pages/LoginPage';
import { MemberHomePage } from './pages/MemberHomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { ReservationsPage } from './pages/ReservationsPage';

function RequireUser() {
  const { user } = useAuth();
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function RequireAdmin() {
  const { user } = useAuth();
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/loading" element={<LoadingPage />} />
        <Route element={<RequireUser />}>
          <Route element={<AppShell />}>
            <Route index element={<MemberHomePage />} />
            <Route path="reservations" element={<ReservationsPage />} />
            <Route path="certifications" element={<CertificationsPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route element={<RequireAdmin />}><Route path="admin" element={<AdminDashboardPage />} /></Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
