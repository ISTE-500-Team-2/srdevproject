// Opened from the link in an email-change message. Like the sign-up confirmation, it waits for a
// click, so a mail scanner that opens links can't change anyone's email.

import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function ConfirmEmailChangePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const [token] = useState(() => location.hash.slice(1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() =>
    TOKEN.test(token) ? "" : "This link is incomplete. Open it from the email again, or request a new link from your profile.",
  );
  const [changedTo, setChangedTo] = useState("");
  // The token is in the fragment; drop it so it doesn't stay in history.
  useEffect(() => {
    if (location.hash) navigate("/confirm-email-change", { replace: true });
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ email: string }>("/auth/email-change/confirm", { method: "POST", body: { token } });
      setChangedTo(result.email);
      if (user) await refresh(false, { fresh: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const onward = user ? (
    <Link className="email-confirm-button" to="/profile#sign-in">
      Go to your profile
    </Link>
  ) : (
    <Link className="email-confirm-button" to="/login" state={{ email: changedTo }}>
      Sign in
    </Link>
  );

  return (
    <main className="email-confirm-screen">
      <section className="email-confirm-card" aria-labelledby="email-change-title">
        <div className="email-confirm-brand">The Crafty Studio</div>
        <div className="email-confirm-content">
          <div className="email-confirm-icon" aria-hidden="true">
            {changedTo ? "✓" : "✉"}
          </div>
          {changedTo ? (
            <>
              <h1 id="email-change-title">Email changed</h1>
              <p role="status">
                You now sign in with <strong>{changedTo}</strong>. Your old address can no longer be used to sign in or reset your
                password.
              </p>
              {onward}
            </>
          ) : (
            <>
              <h1 id="email-change-title">Confirm your new email</h1>
              <p>You’ll sign in with this address from now on.</p>
              {TOKEN.test(token) ? (
                <button className="email-confirm-button" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "Confirming…" : "Confirm new email"}
                </button>
              ) : null}
              {error ? (
                <div role="alert" className="email-confirm-error">
                  <p>{error}</p>
                  <Link to="/profile#sign-in">Go to your profile</Link>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
