import {
  ChevronDown,
  CircleUserRound,
  CreditCard,
  LogOut,
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
import { AppearanceControl } from "./AppearanceControl";
import CardNav from "./reactbits/CardNav";

// CardNav renders plain anchors; route them through the router instead.
const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  ({ href = "/", ...props }, ref) => <Link ref={ref} to={href} {...props} />,
);

// The mobile menu in the site palette: paper panel, espresso, brown and
// orange cards, matching the desktop header.
const cardNavStyle = {
  "--cn-panel": "var(--nav-panel)",
  "--cn-solid": "var(--nav-solid)",
  "--cn-edge": "var(--nav-edge)",
  "--cn-text": "var(--nav-text)",
  "--cn-muted": "var(--nav-muted)",
  "--cn-hover": "var(--nav-hover)",
  "--cn-ring": "var(--orange)",
  "--cn-shadow": "var(--nav-shadow)",
  "--cn-cta": "var(--nav-cta)",
  "--cn-cta-ink": "var(--nav-cta-ink)",
  "--cn-logo": "34px",
} as CSSProperties;

// Pages the header search finds. The desktop links leave out Membership so
// they clear the centred logo; it lives in the account menu (and on phones,
// where this header is hidden, in CardNav).
const navItems: { label: string; to: string; desktop?: boolean }[] = [
  { label: "Home", to: "/" },
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
  const visibleNavItems = navItems.filter((item) => item.desktop !== false);
  // The account menu says where the account stands. Staff without a plan of
  // their own see no pill rather than an invitation to join.
  const membershipStatus =
    user?.membership === "Monthly"
      ? { label: "Active", tone: "ok" }
      : user?.membership === "Day Pass"
        ? { label: "Day pass", tone: "neutral" }
        : user && !hasStaffWorkspace
          ? { label: "Join", tone: "warn" }
          : null;
  const [error, setError] = useState("");
  const navigate = useNavigate();
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
      bgColor: "var(--nav-card-1)",
      textColor: "var(--nav-card-1-ink)",
      links: [
        { label: "Equipment", href: "/equipment" },
        { label: "Studios", href: "/studios" },
        { label: "Classes", href: "/classes" },
      ],
    },
    {
      label: "Account",
      description: user ? `${user.firstName} ${user.lastName}` : undefined,
      bgColor: "var(--nav-card-2)",
      textColor: "var(--nav-card-2-ink)",
      links: [
        { label: "Home", href: "/" },
        { label: "Membership", href: "/membership" },
        { label: "Certifications & Waivers", href: "/certifications" },
        { label: "Account settings", href: "/profile" },
      ],
    },
    {
      label: hasStaffWorkspace ? "Staff" : "Session",
      // Matches the other cards' head so the link rows line up.
      description: hasStaffWorkspace ? "Run the studio." : "Sign out on shared devices.",
      bgColor: "var(--nav-card-3)",
      textColor: "var(--nav-card-3-ink)",
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
        footer={
          <div className="site-card-nav__appearance">
            <AppearanceControl />
          </div>
        }
        onLinkClick={(link) => {
          if (link.signOut) void signOut();
        }}
      />
      <header className="site-header">
        <nav className="site-nav" aria-label="Primary navigation">
          {visibleNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => (isActive ? "site-nav__link is-active" : "site-nav__link")}
            >
              {item.label}
            </NavLink>
          ))}
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
                <div className="account-menu__appearance">
                  <AppearanceControl />
                </div>
                <Link to="/membership" onClick={() => setAccountOpen(false)}>
                  <CreditCard aria-hidden="true" /> Membership
                  {membershipStatus ? (
                    <span className={`status-pill status-pill--${membershipStatus.tone}`}>
                      {membershipStatus.label}
                    </span>
                  ) : null}
                </Link>
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
