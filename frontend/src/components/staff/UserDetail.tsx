import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import { dateTime } from "../../lib/display";
import type {
Entitlement,
MemberDetail,
Plan
} from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { ActionForm,AuditList,EntitlementList,Field,LoadState,PaymentList,ReasonField } from "../Management";
import { SignedWaiverRecords } from '../SignedWaiverRecords';
import { PaymentEditor } from "./PaymentControls";

import { IssueAccess } from "./IssueAccess";

export function UserDetail({
  id,
  plans,
  timeZone,
  onChanged,
}: {
  id: number;
  plans: Plan[];
  timeZone: string;
  onChanged: () => void;
}) {
  const detail = useApi<MemberDetail>(`/admin/users/${id}`),
    { user: actor } = useAuth();
  const [notice, setNotice] = useState(""),
    [renewal, setRenewal] = useState<Entitlement | null>(null);
  const refresh = (message = "Change saved.") => {
    setNotice(message);
    detail.reload();
    onChanged();
  };
  const d = detail.data,
    u = d?.user,
    isAdmin = !!actor?.roles.includes("admin");
  const canManage =
    !!u && (isAdmin || !u.roles.some((r) => r === "admin" || r === "staff"));
  return (
    <div className="management-detail">
      <LoadState {...detail} />
      {notice ? (
        <p role="status" className="form-notice">
          {notice}
        </p>
      ) : null}
      {d && u ? (
        <>
          {isAdmin ? <SignedWaiverRecords userId={id} onChanged={() => refresh("Waiver expiration saved.")} /> : null}
          <section className="panel management-panel">
            <h2>
              {u.firstName} {u.lastName} · Member #{u.id}
            </h2>
            <p>
              {u.email} · {u.roles.join(", ")} · Primary: {u.primaryRole ?? "member"}{u.isStudent ? " · Student" : ""} · Facility access:{" "}
              <strong>{u.accessStatus}</strong>
            </p>
            <p>
              Account status: <strong>{u.status}</strong> · Conduct flag:{" "}
              <strong>{u.conductFlag ? "Yes" : "No"}</strong>
            </p>
            {u.accessReason ? <p>Access note: {u.accessReason}</p> : null}
            {!canManage ? (
              <p>Only an administrator can change this staff account.</p>
            ) : null}
            <details>
              <summary>Edit member details</summary>
              <ActionForm
                key={u.revision}
                title="Edit member details"
                submitLabel="Save member details"
                disabled={!canManage}
                onSubmit={async (f) => {
                  await api(`/admin/users/${id}/profile`, {
                    method: "PATCH",
                    body: {
                      firstName: f.get("firstName"),
                      lastName: f.get("lastName"),
                      phone: f.get("phone"),
                      revision: u.revision,
                      reason: f.get("reason"),
                    },
                  });
                  refresh("Member details saved.");
                }}
              >
                <Field
                  label="First name"
                  name="firstName"
                  defaultValue={u.firstName}
                  maxLength={50}
                />
                <Field
                  label="Last name"
                  name="lastName"
                  defaultValue={u.lastName}
                  maxLength={50}
                />
                <Field
                  label="Phone"
                  name="phone"
                  defaultValue={u.phone}
                  maxLength={15}
                />
                <ReasonField />
              </ActionForm>
            </details>
            <ActionForm
              key={`access-${u.revision}`}
              title="Facility access control"
              submitLabel="Save facility access"
              disabled={!canManage || actor?.id === id}
              onSubmit={async (f) => {
                await api(`/admin/users/${id}/access`, {
                  method: "POST",
                  body: {
                    status: f.get("status"),
                    revision: u.revision,
                    reason: f.get("reason"),
                  },
                });
                refresh("Facility access updated.");
              }}
            >
              <p>
                Active permits eligibility checks; it does not create a
                membership or waive policies. Suspension/revocation blocks new
                check-ins and reservations, but keeps account history and
                existing bookings.
              </p>
              <Field label="Facility access" name="status">
                <select name="status" defaultValue={u.accessStatus}>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                  <option value="revoked">Revoked</option>
                </select>
              </Field>
              <ReasonField />
            </ActionForm>
            {isAdmin ? (
              <details>
                <summary>Change account role</summary>
                <ActionForm
                  key={`role-${u.revision}`}
                  title="Account role"
                  submitLabel="Save account role"
                  disabled={actor?.id === id}
                  onSubmit={async (f) => {
                    await api(`/admin/users/${id}/role`, {
                      method: "POST",
                      body: {
                        primaryRole: f.get("role"),
                        roles: f.getAll("roles"),
                        isStudent: f.get("isStudent") === "on",
                        revision: u.revision,
                        reason: f.get("reason"),
                      },
                    });
                    refresh("Account role updated.");
                  }}
                >
                  <Field label="Account role" name="role">
                    <select
                      name="role"
                      defaultValue={u.primaryRole ?? "member"}
                    >
                      <option value="member">Community member</option>
                      <option value="subscriber">Subscriber</option>
                      <option value="day_pass">Day-pass customer</option>
                      <option value="instructor">Instructor</option>
                      <option value="staff">Staff</option>
                      <option value="admin">Super administrator</option>
                    </select>
                  </Field>
                  <fieldset><legend>Assigned roles (include the primary role)</legend>
                    {[["member","Community member"],["subscriber","Subscriber"],["day_pass","Day-pass customer"],["instructor","Instructor"],["staff","Staff"],["admin","Super administrator"]].map(([value,label]) =>
                      <label key={value}><input type="checkbox" name="roles" value={value} defaultChecked={u.roles.includes(value)} />{label}</label>)}
                  </fieldset>
                  <label><input type="checkbox" name="isStudent" defaultChecked={u.isStudent} />Student classification</label>
                  <ReasonField />
                </ActionForm>
              </details>
            ) : null}
          </section>
          <section className="panel management-panel">
            <IssueAccess
              key={renewal ? `${renewal.id}-${renewal.endsAt}` : "new"}
              id={id}
              plans={plans.filter((p) => p.active)}
              timeZone={timeZone}
              renewal={renewal}
              disabled={!canManage}
              onSaved={() => {
                setRenewal(null);
                refresh("Access issued and payment record saved.");
              }}
            />
          </section>
          <section className="panel management-panel">
            <h2>Memberships & passes</h2>
            <p>
              Most recent 100 of each type. Pass dates use {timeZone};
              membership times use your local timezone.
            </p>
            <EntitlementList
              memberships={d.memberships}
              passes={d.passes}
              actions={(item, kind) => (
                <>
                  {canManage && kind === "membership" && item.endsAt ? (
                    <button
                      className="button button--quiet"
                      onClick={() => {
                        setRenewal(item);
                        setNotice(
                          "Renewal start set to the existing end time. Review the Issue access form above.",
                        );
                      }}
                    >
                      Prepare renewal for {item.plan?.name ?? "membership"}
                    </button>
                  ) : null}
                  {canManage && item.status !== "revoked" ? (
                    <details>
                      <summary>
                        Change {kind === "membership" ? "membership" : "pass"} #
                        {item.id} status
                      </summary>
                      <ActionForm
                        title={`Entitlement ${kind} ${item.id}`}
                        submitLabel="Save entitlement status"
                        onSubmit={async (f) => {
                          await api(
                            `/admin/users/${id}/entitlements/${kind}/${item.id}/status`,
                            {
                              method: "POST",
                              body: {
                                status: f.get("status"),
                                revision: item.revision,
                                reason: f.get("reason"),
                              },
                            },
                          );
                          refresh("Entitlement status updated.");
                        }}
                      >
                        <Field label="Entitlement status" name="status">
                          <select name="status" defaultValue={item.status}>
                            <option value="active">Active</option>
                            <option value="suspended">Suspended</option>
                            <option value="revoked">Revoked (final)</option>
                          </select>
                        </Field>
                        <ReasonField />
                      </ActionForm>
                    </details>
                  ) : null}
                </>
              )}
            />
          </section>
          <section className="panel management-panel">
            <h2>Recent payment records</h2>
            <PaymentList
              page={d.payments}
              actions={(p) =>
                canManage ? (
                  <PaymentEditor
                    key={`${p.id}-${p.revision}`}
                    payment={p}
                    onSaved={() => refresh("Payment record updated.")}
                  />
                ) : null
              }
            />
            {d.payments.nextOffset != null ? (
              <p>
                More records are available under Payment history, filtered by
                member ID {id}.
              </p>
            ) : null}
          </section>
          <section className="panel management-panel">
            <h2>Recent check-ins</h2>
            {d.checkIns.length ? (
              <ul>
                {d.checkIns.map((c) => (
                  <li key={c.id}>
                    {dateTime(c.checkedInAt)} · {c.location} · {c.status}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No check-ins recorded.</p>
            )}
          </section>
          <section className="panel management-panel">
            <h2>Change history</h2>
            <AuditList items={d.audit.items} />
            {d.audit.nextOffset != null ? (
              <p>More entries are available in the full Change log.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
