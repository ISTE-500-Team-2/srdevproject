import {
  ChevronDown,
  CircleUserRound,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { classes, equipment, studioSpaces } from '../data/mockData';

const navItems = [
  { label: 'Home', to: '/' },
  { label: 'Reservations', to: '/reservations' },
  { label: 'Certifications & Waivers', to: '/certifications' },
  { label: 'Classes', to: '/classes' },
];

export function Header() {
  const { user, loginAs, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return [
      ...equipment.map((item) => ({
        key: `equipment-${item.id}`,
        label: item.name,
        detail: item.type,
        to: '/reservations',
      })),
      ...studioSpaces.map((item) => ({
        key: `space-${item.id}`,
        label: item.name,
        detail: `${item.size} studio`,
        to: '/reservations',
      })),
      ...classes.map((item) => ({
        key: `class-${item.id}`,
        label: item.title,
        detail: item.equipment,
        to: '/classes',
      })),
    ]
      .filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(normalized))
      .slice(0, 6);
  }, [query]);

  const goToResult = (to: string) => {
    navigate(to);
    setSearchOpen(false);
    setQuery('');
  };

  return (
    <>
      <header className="site-header">
        <button
          className="icon-button site-header__mobile-toggle"
          onClick={() => setMobileOpen((value) => !value)}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>

        <nav className={`site-nav ${mobileOpen ? 'site-nav--open' : ''}`} aria-label="Primary navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => (isActive ? 'site-nav__link is-active' : 'site-nav__link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <NavLink className="site-header__brand" to="/" aria-label="The Collaboratory home">
          <img src="/assets/collaboratory-logo.webp" alt="The Collaboratory, White Hall, Maryland" />
        </NavLink>

        <div className="site-header__actions">
          {user?.role === 'admin' ? (
            <NavLink className="site-header__admin-link" to="/admin">
              User Management
            </NavLink>
          ) : null}
          <button className="icon-button" onClick={() => setSearchOpen(true)} aria-label="Search">
            <Search aria-hidden="true" />
          </button>
          <div className="account-menu">
            <button
              className="icon-button account-menu__trigger"
              onClick={() => setAccountOpen((value) => !value)}
              aria-label="Open account menu"
              aria-expanded={accountOpen}
            >
              <CircleUserRound aria-hidden="true" />
            </button>
            {accountOpen ? (
              <div className="account-menu__popover">
                <div className="account-menu__identity">
                  <strong>{user ? `${user.firstName} ${user.lastName}` : 'Prototype user'}</strong>
                  <span>{user?.email ?? 'Not signed in'}</span>
                </div>
                <button onClick={() => { navigate('/profile'); setAccountOpen(false); }}>
                  <Settings aria-hidden="true" /> Account settings
                </button>
                <button
                  onClick={() => {
                    loginAs(user?.role === 'admin' ? 'member' : 'admin');
                    navigate(user?.role === 'admin' ? '/' : '/admin');
                    setAccountOpen(false);
                  }}
                >
                  <ShieldCheck aria-hidden="true" />
                  View as {user?.role === 'admin' ? 'member' : 'admin'}
                </button>
                <button
                  onClick={() => {
                    logout();
                    navigate('/login');
                    setAccountOpen(false);
                  }}
                >
                  <LogOut aria-hidden="true" /> Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {searchOpen ? (
        <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Site search">
          <button className="search-overlay__scrim" onClick={() => setSearchOpen(false)} aria-label="Close search" />
          <section className="search-panel">
            <div className="search-panel__input-wrap">
              <Search aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search equipment, studios, or classes…"
                aria-label="Search equipment, studios, or classes"
              />
              <button className="icon-button" onClick={() => setSearchOpen(false)} aria-label="Close search">
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="search-panel__results">
              {!query ? (
                <p className="search-panel__hint">Try “laser,” “CNC,” or “robot.”</p>
              ) : results.length ? (
                results.map((result) => (
                  <button key={result.key} onClick={() => goToResult(result.to)}>
                    <span>
                      <strong>{result.label}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                ))
              ) : (
                <p className="search-panel__hint">No prototype results found for “{query}.”</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
