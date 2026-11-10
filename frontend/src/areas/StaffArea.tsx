// The staff workspace: one chunk, loaded only for staff. Its routes live here
// (relative to /admin) because the section list imports every staff page.
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminShell } from '../components/admin/AdminShell';
import { titled } from '../components/PageTitle';
import { AdminIndex, AdminSectionPage } from '../pages/admin/AdminSectionPage';
import { adminSections } from '../pages/admin/sections';

export default function StaffArea() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={titled('Today', <AdminIndex />)} />
        {adminSections.map((section) => (
          <Route key={section.path} path={section.path === 'equipment' ? 'equipment/:equipmentId?' : section.path} element={titled(section.label, <AdminSectionPage section={section} />)} />
        ))}
        <Route path="*" element={<Navigate replace to="/admin" />} />
      </Route>
    </Routes>
  );
}
