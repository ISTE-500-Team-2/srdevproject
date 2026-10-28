import {
  ChevronDown,
  CircleUserRound,
  LogOut,
  Menu,
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type CSSProperties,
} from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../lib/api";
import CardNav from "./reactbits/CardNav";

// CardNav renders plain anchors; route them through the router instead.
const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  ({ href = "/", ...props }, ref) => <Link ref={ref} to={href} {...props} />,
);

// The mobile menu in the site palette: paper panel, espresso, brown and
// orange cards, matching the desktop header.
const cardNavStyle = {
  "--cn-panel": "rgba(250, 248, 245, 0.94)",
  "--cn-solid": "#faf8f5",
  "--cn-edge": "rgba(92, 73, 62, 0.24)",
  "--cn-text": "#24150e",
  "--cn-muted": "#685d57",
  "--cn-hover": "#f3ece7",
  "--cn-ring": "#f7961d",
  "--cn-shadow": "0 4px 12px rgba(36, 16, 6, 0.09)",
  "--cn-cta": "linear-gradient(135deg, #2b1306, #59300f)",
  "--cn-cta-ink": "#ffffff",
  "--cn-logo": "34px",
} as CSSProperties;

const navItems: { label: string; to: string; desktop?: boolean }[] = [
  { label: "Home", to: "/" },
  // Mobile only. On desktop, Membership is reached from Account settings and
  // the home page, so the links clear the centred logo.
  { label: "Membership", to: "/membership", desktop: false },
  { label: "Equipment", to: "/equipment" },
  { label: "Studios", to: "/studios" },
  { label: "Certifications & Waivers", to: "/certifications" },
  { label: "Classes", to: "/classes" },
];

export function Header() {
  const { user, logout } = useAuth();
  const hasStaffWorkspace = user?.roles.some(
    (role) => role === "staff" || role === "admin",
  );
  // const visibleNavItems = hasStaffWorkspace
  //   ? [...navItems, { label: "Staff workspace", to: "/admin" }]
  //   : navItems;
  const visibleNavItems = navItems;
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return navItems
      .map((item) => ({
        key: item.to,
        label: item.label,
        detail: "Page",
        to: item.to,
      }))
      .filter((item) =>
        `${item.label} ${item.detail}`.toLowerCase().includes(normalized),
      )
      .slice(0, 6);
  }, [query]);

  const goToResult = (to: string) => {
    navigate(to);
    setSearchOpen(false);
    setQuery("");
  };

  const cardNavItems = [
    {
      label: "Book",
      description: "Reserve time in the shop.",
      bgColor: "#241006",
      textColor: "#ffffff",
      links: [
        { label: "Equipment", href: "/equipment" },
        { label: "Studios", href: "/studios" },
        { label: "Classes", href: "/classes" },
      ],
    },
    {
      label: "Account",
      description: user ? `${user.firstName} ${user.lastName}` : undefined,
      bgColor: "#59300f",
      textColor: "#ffffff",
      links: [
        { label: "Home", href: "/" },
        { label: "Membership", href: "/membership" },
        { label: "Certifications & Waivers", href: "/certifications" },
        { label: "Account settings", href: "/profile" },
      ],
    },
    {
      label: hasStaffWorkspace ? "Staff" : "Session",
      bgColor: "#ffdba5",
      textColor: "#241006",
      links: [
        ...(hasStaffWorkspace ? [{ label: "Staff workspace", href: "/admin" }] : []),
        { label: "Sign out", signOut: true },
      ],
    },
  ];

  const signOut = async () => {
    try {
      await logout();
      navigate("/login");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <CardNav
        className="site-card-nav"
        logo="/assets/collaboratory-logo.webp"
        logoAlt="The Collaboratory home"
        logoHref="/"
        items={cardNavItems}
        theme="light"
        surface="glass"
        cardHeight={196}
        linkComponent={RouterLink}
        ariaLabel="Mobile navigation"
        style={cardNavStyle}
        onLinkClick={(link) => {
          if (link.signOut) void signOut();
        }}
      />
      <header className="site-header">
        <button
          className="icon-button site-header__mobile-toggle"
          onClick={() => setMobileOpen((value) => !value)}
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>

        <nav
          className={`site-nav ${mobileOpen ? "site-nav--open" : ""}`}
          aria-label="Primary navigation"
        >
          {visibleNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                [
                  "site-nav__link",
                  isActive ? "is-active" : "",
                  item.desktop === false ? "mobile-only" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
            >
              {item.label}
            </NavLink>
          ))}

          {hasStaffWorkspace ? (
            <NavLink className={({ isActive }) =>
                isActive ? "site-nav__link is-active mobile-only" : "site-nav__link mobile-only"
              } to="/admin">
              Staff workspace
            </NavLink>
          ) : null}
        </nav>

        <NavLink
          className="site-header__brand"
          to="/"
          aria-label="The Collaboratory home"
        >
          <img
            src="/assets/collaboratory-logo.webp"
            alt="The Collaboratory, White Hall, Maryland"
          />
        </NavLink>

        <div className="site-header__actions">
          {hasStaffWorkspace ? (
            <NavLink className="site-header__admin-link" to="/admin">
              Staff workspace
            </NavLink>
          ) : null}
          <button
            className="icon-button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
          >
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
                  <strong>
                    {user ? `${user.firstName} ${user.lastName}` : "Account"}
                  </strong>
                  <span>{user?.email ?? "Not signed in"}</span>
                </div>
                <button
                  onClick={() => {
                    navigate("/profile");
                    setAccountOpen(false);
                  }}
                >
                  <Settings aria-hidden="true" /> Account settings
                </button>
                <button
                  onClick={() => {
                    setAccountOpen(false);
                    void signOut();
                  }}
                >
                  <LogOut aria-hidden="true" /> Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {searchOpen ? (
        <div
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Site search"
        >
          <button
            className="search-overlay__scrim"
            onClick={() => setSearchOpen(false)}
            aria-label="Close search"
          />
          <section className="search-panel">
            <div className="search-panel__input-wrap">
              <Search aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pages…"
                aria-label="Search pages"
              />
              <button
                className="icon-button"
                onClick={() => setSearchOpen(false)}
                aria-label="Close search"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="search-panel__results">
              {!query ? (
                <p className="search-panel__hint">
                  Try “equipment” or “waivers.”
                </p>
              ) : results.length ? (
                results.map((result) => (
                  <button
                    key={result.key}
                    onClick={() => goToResult(result.to)}
                  >
                    <span>
                      <strong>{result.label}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                ))
              ) : (
                <p className="search-panel__hint">
                  No pages found for “{query}.”
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
