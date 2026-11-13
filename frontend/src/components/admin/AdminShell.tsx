import { CalendarDays, Eye, LogOut, Menu } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { errorMessage } from "../../lib/api";
import { adminNavGroups } from "./adminNavigation";
import { AccountPicker } from "./AccountPicker";
import { Modal } from "../Modal";
import { AppearanceControl } from "../AppearanceControl";
import { initials, lastWorkspacePathKey, roleLabel } from "./people";
import { PageWidthContext, type PageWidth } from "./pageWidth";

/** The staff workspace: its own sidebar layout, separate from the member site. */
export function AdminShell() {
  const { user, actor, logout, closeAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [pageWidth, setPageWidth] = useState<PageWidth>("standard");
  const staff = actor ?? user;

  // Arriving in the workspace closes any member account left open. Only on
  // arrival: opening an account from the picker here must not undo itself.
  const openOnArrival = useRef(actor);
  useEffect(() => {
    if (!openOnArrival.current) return;
    openOnArrival.current = null;
    closeAccount().catch((err) => setError(errorMessage(err)));
  }, [closeAccount]);

  useEffect(() => {
    sessionStorage.setItem(lastWorkspacePathKey, location.pathname + location.search);
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  const signOut = async () => {
    try {
      await logout();
      navigate("/login");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `admin-nav__item${isActive ? " is-active" : ""}`;
  const sidebar = (
    <>
      <Link className="admin-side__brand" to="/admin" aria-label="Staff workspace home">
        <img src="/assets/collaboratory-logo.webp" alt="The Collaboratory" />
      </Link>
      <p className="admin-side__label">
        <span>Staff</span>
      </p>
      <nav className="admin-nav" aria-label="Staff workspace">
        <NavLink className={navLinkClass} to="/admin" end>
          <CalendarDays aria-hidden="true" />
          Today
        </NavLink>
        {adminNavGroups.map((group) => (
          <div className="admin-nav__group" key={group.label} role="group" aria-label={group.label}>
            <span className="admin-nav__group-label" aria-hidden="true">
              {group.label}
            </span>
            {group.sections.map(({ path, label, icon: Icon }) => (
              <Fragment key={path}>
                <NavLink className={navLinkClass} to={`/admin/${path}`}>
                  <Icon aria-hidden="true" />
                  {label}
                </NavLink>
                {/* Opening a member's account sits with the people it acts on. */}
                {path === "members" ? (
                  <button
                    type="button"
                    className="admin-nav__item"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setMenuOpen(false);
                      setPickerOpen(true);
                    }}
                  >
                    <Eye aria-hidden="true" />
                    View a member
                  </button>
                ) : null}
              </Fragment>
            ))}
          </div>
        ))}
      </nav>
      <div className="admin-side__appearance">
        <AppearanceControl compact />
      </div>
      {staff ? (
        <div className="admin-side__me">
          <span className="admin-avatar admin-avatar--self" aria-hidden="true">
            {initials(staff.firstName, staff.lastName)}
          </span>
          <span className="admin-side__who">
            <strong>
              {staff.firstName} {staff.lastName}
            </strong>
            <span>{roleLabel(staff)}</span>
          </span>
          <button type="button" className="icon-button admin-side__out" onClick={() => void signOut()} aria-label="Sign out">
            <LogOut aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#admin-main">
        Skip to main content
      </a>
      <aside className="admin-side" aria-label="Workspace navigation">
        {sidebar}
      </aside>
      <Modal open={menuOpen} width="navigation" title="Workspace navigation" onClose={() => setMenuOpen(false)}>
        {sidebar}
      </Modal>
      <div className="admin-main">
        <header className="admin-top">
          <button type="button" className="icon-button admin-top__menu" aria-label="Open navigation" aria-expanded={menuOpen} onClick={(event) => {
            // WebKit does not focus buttons on tap. Give the dialog a return target.
            event.currentTarget.focus({ preventScroll: true });
            setMenuOpen(true);
          }}>
            <Menu aria-hidden="true" />
          </button>
          <Link className="admin-top__brand" to="/admin" aria-label="Staff workspace home">
            <img src="/assets/collaboratory-logo.webp" alt="" />
          </Link>
        </header>
        {error ? (
          <p className="form-error admin-error" role="alert">
            {error}
          </p>
        ) : null}
        <main id="admin-main" className="admin-content page-enter" data-width={pageWidth}>
          <PageWidthContext.Provider value={setPageWidth}>
            <Outlet />
          </PageWidthContext.Provider>
        </main>
      </div>
      {pickerOpen ? <AccountPicker onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}
