import { CalendarDays, Eye, LogOut, Menu, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { errorMessage } from "../../lib/api";
import { adminGroups } from "../../pages/admin/sections";
import { AccountPicker } from "./AccountPicker";
import { Modal } from "../Modal";
import { initials, lastWorkspacePathKey, roleLabel } from "./people";

/** The staff workspace: its own sidebar layout, separate from the member site. */
export function AdminShell() {
  const { user, actor, logout, closeAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
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

  const findMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = query.trim();
    navigate(term ? `/admin/members?search=${encodeURIComponent(term)}` : "/admin/members");
    setQuery("");
  };
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
      <p className="admin-side__label">Staff workspace</p>
      <nav className="admin-nav" aria-label="Staff workspace">
        <NavLink className={navLinkClass} to="/admin" end>
          <CalendarDays aria-hidden="true" />
          Today
        </NavLink>
        {adminGroups.map((group) => (
          <div className="admin-nav__group" key={group.label} role="group" aria-label={group.label}>
            <span className="admin-nav__group-label" aria-hidden="true">
              {group.label}
            </span>
            {group.sections.map(({ path, label, icon: Icon }) => (
              <NavLink key={path} className={navLinkClass} to={`/admin/${path}`}>
                <Icon aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <button type="button" className="button admin-side__view" onClick={() => setPickerOpen(true)}>
        <Eye aria-hidden="true" />
        View member site
      </button>
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
          <form className="admin-top__search" role="search" onSubmit={findMember}>
            <Search aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a member by name or email"
              aria-label="Find a member by name or email"
              maxLength={100}
            />
          </form>
          <button type="button" className="button admin-top__view" aria-label="View member site" title="View member site" onClick={() => setPickerOpen(true)}>
            <Eye aria-hidden="true" />
            <span>View member site</span>
          </button>
        </header>
        {error ? (
          <p className="form-error admin-error" role="alert">
            {error}
          </p>
        ) : null}
        <main id="admin-main" className="admin-content page-enter">
          <Outlet />
        </main>
      </div>
      {pickerOpen ? <AccountPicker onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}
