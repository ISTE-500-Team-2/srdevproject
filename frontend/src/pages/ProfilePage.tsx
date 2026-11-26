// Member settings are split into independently saved sections so editing contact details does not
// replace unrelated preferences.

import { BadgeCheck, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { AccountPhoto } from "../components/AccountPhoto";
import { Toast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { jumpToSection } from "../lib/sectionJump";
import { BillingSection } from "./profile/BillingSection";
import { ContactSection } from "./profile/ContactSection";
import { DocumentsSection } from "./profile/DocumentsSection";
import { HelpSection } from "./profile/HelpSection";
import { MinorsSection } from "./profile/MinorsSection";
import { SECTIONS, useCurrentSection } from "./profile/nav";
import { NotificationsSection } from "./profile/NotificationsSection";
import { ProfileSection } from "./profile/ProfileSection";
import { useProfile } from "./profile/useProfile";
import { SignInSection } from "./ProfileSignIn";
import "./profile.css";

export { formatPhone, phoneToSave } from "./profile/phone";

export function ProfilePage() {
  const { user, actor, refresh } = useAuth();
  // Staff with a member's account open see the member's settings but can't change them.
  const acting = !!actor && !!user && actor.id !== user.id;
  // Only adults sponsor minors; the session says whether this account is under 18.
  const sponsors = user?.isMinor === false;
  const sections = sponsors ? SECTIONS : SECTIONS.filter((s) => s.id !== "minors");
  const current = useCurrentSection(sections);
  const { profile, toast, setToast, error, setError, setAttempt, updateProfile, save } = useProfile(refresh);
  if (!user) return null;
  return (
    <div className="account-page page-enter">
      <section className="account-hero">
        <AccountPhoto person={user} className="profile-hero__avatar" />
        <div>
          <h1>
            {user.firstName} {user.lastName}
          </h1>
          <div className="account-hero__facts">
            {user.membership !== "None" ? <span className="membership-pill">{user.membership === "Day Pass" ? "Day pass" : `${user.membership} membership`}</span> : null}
            <span>
              <BadgeCheck aria-hidden="true" /> Member ID {String(user.id).padStart(6, "0")}
            </span>
            <span>
              <Mail aria-hidden="true" /> {user.email}
            </span>
          </div>
        </div>
      </section>
      {acting ? (
        <p className="account-acting">
          You’re viewing {user.firstName}’s settings. Members change these themselves; to fix {user.firstName}’s name or phone, or add a
          missing date of birth, open <Link to={`/admin/members?member=${user.id}`}>their member record</Link>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}{" "}
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="account-layout">
        <nav className="account-nav" aria-label="Account sections">
          {sections.map(({ id, label, Icon }) => (
            <a key={id} href={`#${id}`} className={current === id ? "is-active" : ""} aria-current={current === id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jumpToSection(id);
              }}
            >
              <Icon aria-hidden="true" /> {label}
            </a>
          ))}
        </nav>
        <div className="account-main">
          <ProfileSection user={user} profile={profile} save={save} notify={setToast} readOnly={acting} />
          <ContactSection
            user={user}
            profile={profile}
            save={save}
            readOnly={acting}
            missing={profile ? undefined : error ? "Unavailable" : "Loading…"}
          />
          <SignInSection profile={profile} onProfile={updateProfile} notify={setToast} />
          <BillingSection />
          {sponsors ? <MinorsSection notify={setToast} readOnly={acting} /> : null}
          <NotificationsSection readOnly={acting} />
          <DocumentsSection adminOnly={acting && !actor?.roles.includes("admin")} />
          <HelpSection profile={profile} />
        </div>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
