import { useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import { useApi } from "../lib/useApi";
import type {
  Entitlement,
  MemberDetail,
  Page,
  Person,
  Plan,
} from "../lib/staffContracts";
import {
  ActionForm,
  AuditList,
  EntitlementList,
  Field,
  LoadState,
  Pager,
  PaymentList,
  ReasonField,
  dateTime,
  dollars,
  localInput,
  zonedDay,
} from "../components/Management";
import { PaymentEditor, PaymentMethod } from "./StaffPayments";

export function StaffUsers() {
  const [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<number | null>(null);
  const users = useApi<Page<Person>>(
    `/admin/users?search=${encodeURIComponent(search)}&offset=${offset}`,
  );
  const plans = useApi<Plan[]>("/admin/plans"),
    config = useApi<{ timeZone: string }>("/config");
  return (
    <section className="management-members">
      <aside className="panel management-panel">
        <h2>Members and staff</h2>
        <form
          className="management-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(
              String(new FormData(e.currentTarget).get("search") ?? ""),
            );
            setOffset(0);
          }}
        >
          <label>
            Find a member{" "}
            <input name="search" placeholder="Name or email" maxLength={100} />
          </label>
          <button className="button button--quiet">Search members</button>
        </form>
        <LoadState {...users} />
        {users.data ? (
          <>
            <div className="management-user-list">
              {users.data.items.map((p) => (
                <button
                  key={p.id}
                  className={selected === p.id ? "is-selected" : ""}
                  onClick={() => setSelected(p.id)}
                >
                  <strong>
                    {p.firstName} {p.lastName} <small>#{p.id}</small>
                  </strong>
                  <span>{p.email}</span>
                  <small>
                    {p.roles.join(", ")} · Access {p.accessStatus}
                  </small>
                </button>
              ))}
            </div>
            {!users.data.items.length ? <p>No matching members.</p> : null}
            <Pager
              offset={offset}
              nextOffset={users.data.nextOffset}
              onChange={setOffset}
            />
          </>
        ) : null}
      </aside>
      {selected ? (
        <UserDetail
          key={selected}
          id={selected}
          plans={plans.data ?? []}
          timeZone={config.data?.timeZone ?? "America/New_York"}
          onChanged={users.reload}
        />
      ) : (
        <div className="panel management-panel">
          <h2>Select a member</h2>
          <p>
            Review access, issue memberships or day passes, and inspect payment
            and change history.
          </p>
        </div>
      )}
    </section>
  );
}
function UserDetail({
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
          <section className="panel management-panel">
            <h2>
              {u.firstName} {u.lastName} · Member #{u.id}
            </h2>
            <p>
              {u.email} · {u.roles.join(", ")} · Facility access:{" "}
              <strong>{u.accessStatus}</strong>
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
                        role: f.get("role"),
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
                      defaultValue={
                        u.roles.includes("admin")
                          ? "admin"
                          : u.roles.includes("staff")
                            ? "staff"
                            : "member"
                      }
                    >
                      <option value="member">Member</option>
                      <option value="staff">Staff</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </Field>
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
function IssueAccess({
  id,
  plans,
  timeZone,
  renewal,
  disabled,
  onSaved,
}: {
  id: number;
  plans: Plan[];
  timeZone: string;
  renewal: Entitlement | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [planId, setPlanId] = useState(String(renewal?.planId ?? ""));
  const selected = plans.find((p) => p.id === Number(planId));
  const retry = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const renewalDate = renewal?.endsAt ? new Date(renewal.endsAt) : null;
  const startValue = renewalDate
    ? new Date(renewalDate.getTime() - renewalDate.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, -1)
    : localInput();
  return (
    <ActionForm
      title="Issue membership or day pass"
      submitLabel="Issue access"
      disabled={disabled}
      onSubmit={async (f) => {
        if (!selected)
          throw new ApiError(400, "INVALID_INPUT", "Choose an active plan.");
        const body = {
          planId: selected.id,
          startsAt:
            selected.kind === "membership"
              ? new Date(String(f.get("startsAt"))).toISOString()
              : null,
          validDate:
            selected.kind === "day_pass" ? String(f.get("validDate")) : null,
          paymentStatus: f.get("paymentStatus"),
          method: f.get("method"),
          reference: f.get("reference"),
          reason: f.get("reason"),
        };
        const fingerprint = JSON.stringify(body);
        if (retry.current?.fingerprint !== fingerprint)
          retry.current = { fingerprint, requestId: crypto.randomUUID() };
        await api(`/admin/users/${id}/entitlements`, {
          method: "POST",
          body: { ...body, requestId: retry.current.requestId },
        });
        retry.current = null;
        onSaved();
      }}
    >
      <Field label="Access plan" name="planId">
        <select
          name="planId"
          required
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
        >
          <option value="">Choose a plan</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {dollars(p.price)}
            </option>
          ))}
        </select>
      </Field>
      {selected?.kind === "membership" ? (
        <>
          <Field
            label="Membership starts (your local timezone)"
            name="startsAt"
            type="datetime-local"
            step="0.001"
            defaultValue={startValue}
          />
          <p>
            Ends after {selected.months} calendar month(s). Existing overlapping
            active/suspended memberships are rejected.
          </p>
        </>
      ) : selected ? (
        <Field
          label={`Pass valid date (${timeZone})`}
          name="validDate"
          type="date"
          defaultValue={zonedDay(timeZone)}
        />
      ) : null}
      <Field label="Initial payment record" name="paymentStatus">
        <select name="paymentStatus">
          <option value="pending">Pending</option>
          <option value="paid">Paid externally</option>
          <option value="waived">Waived (zero amount)</option>
        </select>
      </Field>
      <PaymentMethod />
      <Field
        label="External receipt/reference (no card details)"
        name="reference"
        required={false}
        maxLength={100}
      />
      <ReasonField />
      <p>
        This grants dated access and records the plan price. It does not collect
        payment or bypass signed-policy requirements.
      </p>
    </ActionForm>
  );
}
