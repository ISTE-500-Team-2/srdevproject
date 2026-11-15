// The profile page's Sign-in section: the member changes the email and password they sign in with.
// Both need the current password; a new email only applies once its emailed link is opened.

import { KeyRound, Mail, Pencil } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { PendingEmail, UserProfile } from "../lib/contracts";
import { shortDate } from "../lib/display";
import { Detail, FormMessage, Section, SectionForm } from "./profileSections";

// Mirrors sign-up and reset (ResetPasswordPage): the server checks length; the form also asks for
// an uppercase letter and a special character. Length counts UTF-8 bytes, as bcrypt does.
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const PASSWORD_HINT = "8–72 characters, with an uppercase letter and a special character.";
function passwordProblem(value: string) {
  if (value.length < 8 || utf8Bytes(value) > 72) return "Use 8–72 characters. Accented letters and emoji count as more than one.";
  if (!/[A-Z]/.test(value)) return "Include an uppercase letter.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Include a special character, such as ! or #.";
  return "";
}

type Editing = "password" | "email" | null;

export function SignInSection({
  profile,
  onProfile,
  notify,
}: {
  profile: UserProfile | null;
  /** The member's profile changed here (pending email, password date). */
  onProfile: (change: Partial<UserProfile>) => void;
  notify: (message: string) => void;
}) {
  const { user, actor, refresh } = useAuth();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!user) return null;
  const ownAccount = !actor || actor.id === user.id;
  const pending = profile?.pendingEmail ?? null;
  const changedAt = profile?.passwordChangedAt;

  const pendingAction = async (run: () => Promise<{ pendingEmail: PendingEmail | null }>, done: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await run();
      onProfile({ pendingEmail: result.pendingEmail });
      notify(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const body = () => {
    if (editing === "password")
      return (
        <SectionForm
          saveLabel="Change password"
          onCancel={() => setEditing(null)}
          onSave={async (form) => {
            const next = String(form.get("newPassword") ?? "");
            const problem = passwordProblem(next);
            if (problem) throw new FormMessage(problem);
            if (next !== String(form.get("repeatPassword") ?? "")) throw new FormMessage("The new passwords don’t match.");
            // The response is a fresh sign-in for this browser; api() keeps its tokens.
            await api("/me/password", { method: "POST", body: { currentPassword: form.get("currentPassword"), newPassword: next } });
            // The server also cancels a waiting email change: it may not have been the member's.
            onProfile({ passwordChangedAt: new Date().toISOString(), pendingEmail: null });
            setEditing(null);
            notify(
              pending
                ? "Password changed. Your other devices are signed out, and the waiting email change was cancelled."
                : "Password changed. Your other devices are signed out.",
            );
            await refresh(false, { fresh: true });
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>Current password</span>
              <input name="currentPassword" type="password" required autoComplete="current-password" />
            </label>
            <span aria-hidden="true" />
            <label className="form-field">
              <span>New password</span>
              <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" aria-describedby="sign-in-password-hint" />
            </label>
            <label className="form-field">
              <span>Repeat new password</span>
              <input name="repeatPassword" type="password" required minLength={8} autoComplete="new-password" />
            </label>
          </div>
          <p className="account-hint" id="sign-in-password-hint">
            {PASSWORD_HINT} Other devices you’re signed in on will be signed out; you stay signed in here.
          </p>
        </SectionForm>
      );
    if (editing === "email")
      return (
        <SectionForm
          saveLabel="Send confirmation link"
          onCancel={() => setEditing(null)}
          onSave={async (form) => {
            const email = String(form.get("email") ?? "").trim();
            const result = await api<{ pendingEmail: PendingEmail; emailSendingEnabled: boolean }>("/me/email-change", {
              method: "POST",
              body: { email, currentPassword: form.get("currentPassword") },
            });
            onProfile({ pendingEmail: result.pendingEmail });
            setEditing(null);
            notify(
              result.emailSendingEnabled
                ? `Check ${result.pendingEmail.email} for a confirmation link.`
                : "Email delivery is off in this environment, so no link was sent.",
            );
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>New email</span>
              <input name="email" type="email" required maxLength={100} autoComplete="email" defaultValue={pending?.email ?? ""} />
            </label>
            <label className="form-field">
              <span>Current password</span>
              <input name="currentPassword" type="password" required autoComplete="current-password" />
            </label>
          </div>
          <p className="account-hint">
            We’ll email a link to the new address. Your email doesn’t change until you open it. We’ll also let your current address know.
          </p>
        </SectionForm>
      );
    return (
      <>
        {pending ? (
          <p className="account-signin__pending" role="status">
            Check <strong>{pending.email}</strong> for a confirmation link. It expires {shortDate(pending.expiresAt)}. Until then you
            still sign in with your current email.
          </p>
        ) : null}
        <dl className="account-details">
          <Detail label="Email">{user.email}</Detail>
          <Detail label="Password">{changedAt ? `Last changed ${shortDate(changedAt, true)}` : "Set"}</Detail>
        </dl>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {!ownAccount ? (
          <p className="account-hint">Members change their own email and password.</p>
        ) : (
          <div className="account-signin__actions">
            {pending ? (
              <>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() =>
                    void pendingAction(() => api("/me/email-change/resend", { method: "POST" }), `Link sent again to ${pending.email}.`)
                  }
                >
                  Send the link again
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => void pendingAction(() => api("/me/email-change", { method: "DELETE" }), "Email change cancelled.")}
                >
                  Cancel the change
                </button>
              </>
            ) : null}
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => setEditing("email")}>
              <Mail aria-hidden="true" /> {pending ? "Use a different email" : "Change email"}
            </button>
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => setEditing("password")}>
              <Pencil aria-hidden="true" /> Change password
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <Section id="sign-in" title="Sign-in" note="The email and password you sign in with." Icon={KeyRound} editing={editing !== null}>
      {body()}
    </Section>
  );
}
