import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { errorMessage } from "../../lib/api";
import { AccountPicker } from "./AccountPicker";
import { initials, lastWorkspacePathKey, roleLabel } from "./people";

/** Stays on top of every member page while staff have someone's account open. */
export function AccountBar() {
  const { user, actor, closeAccount } = useAuth();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!user || !actor) return null;
  const own = user.id === actor.id;
  const role = roleLabel(actor);

  const back = async () => {
    setBusy(true);
    setError("");
    try {
      await closeAccount();
      navigate(sessionStorage.getItem(lastWorkspacePathKey) ?? "/admin");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <section className="account-bar" aria-label="Account you are working in">
        <span className="admin-avatar account-bar__avatar" aria-hidden="true">
          {initials(user.firstName, user.lastName)}
        </span>
        <div className="account-bar__text">
          <p className="account-bar__line">
            {own ? (
              <>You're in <strong>your own account</strong> as {role === "Admin" ? "an" : ""}</>
            ) : (
              <>
                You're in{" "}
                <strong>
                  {user.firstName} {user.lastName}'s
                </strong>{" "}
                account as {role === "Admin" ? "an" : ""}
              </>
            )}{" "}
            <span className={`account-role account-role--${role.toLowerCase()}`}>{role}</span>
          </p>
          <p className="account-bar__sub">
            {own
              ? "This is the member site as you see it."
              : `Bookings, sign-ups and payments go on ${user.firstName}'s account and are logged as done by you.`}
          </p>
          {error ? (
            <p className="account-bar__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="account-bar__actions">
          <button type="button" className="button account-bar__switch" onClick={() => setPicking(true)} disabled={busy}>
            <ArrowLeftRight aria-hidden="true" />
            Switch account
          </button>
          <button type="button" className="button account-bar__back" onClick={() => void back()} disabled={busy}>
            <ArrowLeft aria-hidden="true" />
            {busy ? "Going back…" : "Back to workspace"}
          </button>
        </div>
      </section>
      {picking ? <AccountPicker onClose={() => setPicking(false)} /> : null}
    </>
  );
}
