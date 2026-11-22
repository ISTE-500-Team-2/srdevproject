import { Clock, UserPlus, UserRound, Users } from "lucide-react";
import { useState } from "react";
import HoldButton from "../../components/reactbits/HoldButton";
import { api, errorMessage } from "../../lib/api";
import type { SupervisedMinors } from "../../lib/contracts";
import { shortDate, timeOnly } from "../../lib/display";
import { useApi } from "../../lib/useApi";
import { Section, SectionForm, useReturnFocus } from "../profileSections";

/** Adults link a child's account here; the child accepts in their own account. */
export function MinorsSection({ notify, readOnly }: { notify: (message: string) => void; readOnly: boolean }) {
  const state = useApi<SupervisedMinors>("/me/minors", { retainOnReload: true });
  const [adding, setAdding] = useState(false);
  const opener = useReturnFocus(adding);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const minors = state.data?.minors ?? [];
  const requests = state.data?.requests ?? [];
  // The server only takes requests from active adults with a date of birth on file; older
  // accounts have none, so they're told what to do instead of being offered a form that fails.
  const canLink = !readOnly && state.data?.canSponsor === true;
  const act = async (key: string, path: string, message: string) => {
    setBusy(key);
    setError("");
    try {
      await api(path, { method: "POST", body: {} });
      state.reload();
      notify(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      id="minors"
      title="Minors you supervise"
      note="Members under 18 visit with you and check out when you do."
      Icon={Users}
      editing={adding}
      action={
        canLink && !adding ? (
          <button ref={opener} type="button" className="button button--quiet account-edit" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" /> Link a minor
          </button>
        ) : null
      }
    >
      {state.loading && !state.data ? <p role="status">Loading minors…</p> : null}
      {state.error ? <p className="form-error">{state.error}</p> : null}
      {adding ? (
        <SectionForm
          saveLabel="Send request"
          onCancel={() => setAdding(false)}
          onSave={async (form) => {
            const sent = await api<{ minorName: string }>("/me/minors/requests", {
              method: "POST",
              body: { email: String(form.get("email") ?? "").trim(), dob: String(form.get("dob") ?? "") },
            });
            setAdding(false);
            state.reload();
            notify(`Request sent to ${sent.minorName}.`);
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>Their account email</span>
              <input name="email" type="email" required maxLength={255} autoComplete="off" />
            </label>
            <label className="form-field">
              <span>Their date of birth</span>
              <input name="dob" type="date" required max={new Date().toISOString().slice(0, 10)} />
            </label>
          </div>
          <p className="account-hint">
            They’ll see your request on their home page and choose whether to accept. Both of you need your own
            membership or pass and signed waivers to visit.
          </p>
        </SectionForm>
      ) : null}
      {state.data && !readOnly && !state.data.canSponsor ? (
        <p className="account-hint">
          {state.data.dobOnFile
            ? "Linking a minor needs an account with active access. Ask staff about your account."
            : "Linking a minor needs your date of birth, and there isn’t one on file for your account. Ask staff to add it."}
        </p>
      ) : null}
      {state.data && !minors.length && !requests.length && !adding ? (
        <p className="account-hint">
          No minors linked yet.
          {canLink ? (
            <>
              {" "}
              <button type="button" className="account-hint__action" onClick={() => setAdding(true)}>
                Link a child’s account
              </button>{" "}
              to visit together.
            </>
          ) : null}
        </p>
      ) : null}
      {minors.length || requests.length ? (
        <ul className="account-docs account-docs--people">
          {minors.map((minor) => (
            <li key={`minor-${minor.id}`}>
              <span className="account-docs__icon">
                <UserRound aria-hidden="true" />
              </span>
              <div>
                <b>{minor.name}</b>
                <p>
                  {minor.visit
                    ? `Checked in since ${timeOnly(minor.visit.checkedInAt)} · ${minor.visit.buildingName}`
                    : "Not in the building"}
                </p>
              </div>
              {readOnly ? null : (
                <HoldButton
                  className="site-hold-button"
                  disabled={busy !== null}
                  holdTime={1200}
                  radius={9}
                  backgroundColor="var(--hold-danger-bg)"
                  fillColor="var(--hold-danger)"
                  textColor="var(--hold-danger-text)"
                  fillTextColor="var(--hold-danger-ink)"
                  doneLabel="Unlinking…"
                  onHold={() =>
                    void act(`unlink-${minor.id}`, `/me/minors/${minor.id}/unlink`, `${minor.name} is no longer linked to you.`)
                  }
                >
                  Hold to unlink
                </HoldButton>
              )}
            </li>
          ))}
          {requests.map((request) => (
            <li key={`request-${request.id}`}>
              <span className="account-docs__icon">
                <Clock aria-hidden="true" />
              </span>
              <div>
                <b>{request.minorName}</b> <span className="status-pill status-pill--neutral">Pending</span>
                <p>Sent {shortDate(request.createdAt)} · waiting for them to accept</p>
              </div>
              {readOnly ? null : (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy !== null}
                  aria-label={`Cancel request to ${request.minorName}`}
                  onClick={() =>
                    void act(
                      `cancel-${request.id}`,
                      `/me/minors/requests/${request.id}/cancel`,
                      `Request to ${request.minorName} cancelled.`,
                    )
                  }
                >
                  {busy === `cancel-${request.id}` ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
