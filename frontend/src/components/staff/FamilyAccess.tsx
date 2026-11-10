import { useState } from "react";
import { api } from "../../lib/api";
import type { SupervisionSummary } from "../../lib/contracts";
import { timeOnly } from "../../lib/display";
import { useApi } from "../../lib/useApi";
import { ActionForm, LoadState, ReasonField } from "../Management";
import { MemberSelect } from "../MemberSelect";

const firstName = (name: string) => name.split(" ")[0] ?? name;

/**
 * Staff member record: who is in the building, and which adult a minor
 * visits with. Same anatomy as the rest of the record: heading with pills,
 * facts, the cascade note, then actions in their own sections.
 */
export function FamilyAccess({
  userId,
  memberName,
  disabled = false,
}: {
  userId: number;
  memberName?: string;
  disabled?: boolean;
}) {
  const root = `/admin/users/${userId}/supervision`;
  const state = useApi<SupervisionSummary>(root, { refreshInterval: 15000, retainOnReload: true });
  // null until staff pick someone; until then the current sponsor is shown chosen.
  const [picked, setPicked] = useState<string | null>(null);
  const data = state.data;
  const visit = data?.visit ?? null;
  const sponsor = data?.sponsor ?? null;
  const adult = picked ?? (sponsor ? String(sponsor.id) : "");
  const who = memberName ? firstName(memberName) : "this minor";
  return (
    <section className="panel management-panel" aria-labelledby={`family-${userId}-title`}>
      <div className="member-record__heading">
        <h2 id={`family-${userId}-title`}>Visit &amp; supervision</h2>
        {data ? (
          <div className="member-record__pills">
            {data.isMinor ? <span className="status-pill status-pill--warn">{data.marker ?? "Under 18"}</span> : null}
            <span className={`status-pill status-pill--${visit ? "ok" : "neutral"}`}>
              {visit ? "Checked in" : "Checked out"}
            </span>
          </div>
        ) : null}
      </div>
      <LoadState loading={state.loading && !data} error={state.error} reload={state.reload} />
      {data ? (
        <>
          <dl className="member-record__facts">
            <div>
              <dt>Visit</dt>
              <dd>
                {visit ? (visit.buildingName ?? "In the building") : "Not in the building"}
                {visit ? <small>Since {timeOnly(visit.checkedInAt)}</small> : null}
              </dd>
            </div>
            {data.isMinor ? (
              <div>
                <dt>Sponsoring adult</dt>
                <dd>
                  {sponsor?.name ?? "Not linked"}
                  {sponsor?.email ? <small>{sponsor.email}</small> : null}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="member-record__note">
            {data.isMinor
              ? sponsor
                ? `${firstName(sponsor.name)} must stay checked in while ${who} is here. Checking ${firstName(sponsor.name)} out ends ${memberName ? `${who}’s` : "the minor’s"} visit too.`
                : "Link a sponsoring adult before this minor can check in. Each person needs their own membership or pass and signed policies."
              : "Checking this adult out also ends visits for any minors they supervise."}
          </p>
          {data.isMinor && !visit ? (
            <details className="member-record__section" open>
              <summary>{sponsor ? "Change sponsoring adult" : "Link sponsoring adult"}</summary>
              <ActionForm
                key={sponsor?.revision ?? 0}
                title="Sponsoring adult"
                submitLabel="Save sponsoring adult"
                disabled={disabled}
                submitDisabled={!adult || adult === String(sponsor?.id)}
                onSubmit={async (form) => {
                  await api(root, {
                    method: "POST",
                    body: {
                      adultId: Number(adult),
                      revision: sponsor?.revision ?? 0,
                      consent: form.get("consent") === "on",
                      reason: form.get("reason"),
                    },
                  });
                  setPicked(null);
                  state.reload();
                }}
              >
                <MemberSelect
                  label="Adult account"
                  name="adultId"
                  value={adult}
                  onChange={setPicked}
                  selectedMember={sponsor ? { id: sponsor.id, name: sponsor.name, email: sponsor.email ?? "" } : undefined}
                />
                <label className="management-checkbox">
                  <input type="checkbox" name="consent" required />
                  <span>I verified in person that this adult agrees to sponsor this minor.</span>
                </label>
                <ReasonField />
              </ActionForm>
            </details>
          ) : null}
          <details key={visit ? `out-${visit.id}` : "in"} className="member-record__section" open={!!visit}>
            <summary>{visit ? "Check out" : "Check in with staff"}</summary>
            <ActionForm
              key={visit?.id ?? "new-visit"}
              title={visit ? "End facility visit" : "Start facility visit"}
              submitLabel={visit ? "Check out" : "Check in"}
              disabled={disabled}
              submitDisabled={!visit && data.isMinor && !sponsor}
              onSubmit={async (form) => {
                await api(`${root}/${visit ? "check-out" : "check-in"}`, {
                  method: "POST",
                  body: { reason: form.get("reason") },
                });
                state.reload();
              }}
            >
              {!visit ? (
                <p>
                  {data.isMinor
                    ? "Confirm the minor and their sponsoring adult are both here. The adult checks in first."
                    : "Confirm this person is here."}
                </p>
              ) : null}
              <ReasonField />
            </ActionForm>
          </details>
          {data.isMinor && visit ? (
            <details className="member-record__section is-locked">
              <summary aria-disabled="true" onClick={(event) => event.preventDefault()}>
                <span>Change sponsoring adult</span> <small>Check out first</small>
              </summary>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
