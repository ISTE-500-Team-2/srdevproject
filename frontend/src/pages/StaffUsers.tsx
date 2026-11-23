// Member search and record selection for the staff workspace, with filters retained as selection changes.

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { initials } from "../components/admin/people";
import { MemberPhoto } from "../components/MemberPhoto";
import { rememberAccount } from "../lib/recentAccounts";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../lib/api";
import { KeptResults, useResultsPaging } from "../components/KeptResults";
import { LoadState, Pager } from "../components/Management";
import { MemberRecord } from "../components/staff/record/MemberRecord";
import { accessWords, accountWords, roleName } from "../components/staff/record/recordModel";
import type { Page, Person, Plan } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

/** Staff directory: a searchable table; a member's record opens beside it. */
export function StaffUsers() {
  // ?search= comes from the workspace's member search; ?member= opens a record.
  const [params, setParams] = useSearchParams();
  const linkedSearch = params.get("search") ?? "";
  const linkedMember = Number(params.get("member")) || null;
  const [input, setInput] = useState(linkedSearch),
    [search, setSearch] = useState(linkedSearch.trim()),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Person | null>(null),
    [opening, setOpening] = useState(false),
    [openError, setOpenError] = useState("");
  const { openAccount } = useAuth();
  const navigate = useNavigate();
  const linked = useApi<{ user: Person }>(
    linkedMember && selected?.id !== linkedMember ? `/admin/users/${linkedMember}` : null,
  );
  useEffect(() => {
    if (linked.data) setSelected(linked.data.user);
  }, [linked.data]);
  useEffect(() => {
    setInput(linkedSearch);
  }, [linkedSearch]);
  // A return from checkout (?billing= or ?pass=) is news only for the member it came back to.
  const checkout = (status: string) =>
    selected?.id === linkedMember && (params.get("billing") === status || params.get("pass") === status);
  const close = () => {
    setSelected(null);
    setOpenError("");
    if (["member", "billing", "pass"].some((key) => params.has(key))) {
      const next = new URLSearchParams(params);
      for (const key of ["member", "billing", "pass"]) next.delete(key);
      setParams(next, { replace: true });
    }
  };
  const openMemberAccount = async (person: Person) => {
    setOpening(true);
    setOpenError("");
    try {
      await openAccount(person.id);
      rememberAccount(person);
      navigate("/");
    } catch (err) {
      setOpenError(errorMessage(err));
      setOpening(false);
    }
  };
  // Search as staff type, without a separate button.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(input.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input]);
  const users = useApi<Page<Person>>(
    `/admin/users?search=${encodeURIComponent(search)}&offset=${offset}`,
    { retainOnReload: true, retainOnChange: true, refreshInterval: 5000 },
  );
  const { results, turn, busy } = useResultsPaging(users);
  const plans = useApi<Plan[]>("/admin/plans"),
    config = useApi<{ timeZone: string }>("/config", { reuse: true });
  return (
    <section className="staff-directory">
      <div className="staff-directory__head">
        <h2>Members and staff</h2>
        <label className="staff-directory__search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search members by name or email"
            maxLength={100}
          />
        </label>
      </div>
      {/* A link to one member's record: say it's opening, or why it didn't. */}
      {linkedMember && selected?.id !== linkedMember ? (
        linked.error ? (
          <p role="alert" className="form-error">
            Member #{linkedMember}’s record didn’t open. {linked.error}{" "}
            <button type="button" onClick={linked.reload}>
              Retry
            </button>
          </p>
        ) : linked.loading ? (
          <p role="status">Opening member #{linkedMember}’s record…</p>
        ) : null
      ) : null}
      <LoadState {...users} loading={users.loading && !users.data} />
      {users.data ? (
        <KeptResults read={users} ref={results}>
          {users.data.items.length ? (
            <div className="staff-directory__table table-scroll" role="region" aria-label="Members and staff" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Account</th>
                    <th scope="col">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((p) => (
                    <tr key={p.id} className={selected?.id === p.id ? "is-selected" : ""}>
                      <td>
                        <span className="staff-directory__who">
                          <MemberPhoto id={p.id} version={p.photoVersion} className={`admin-avatar admin-avatar--${p.id % 5} staff-directory__avatar`}>
                            {initials(p.firstName, p.lastName)}
                          </MemberPhoto>
                          <button type="button" onClick={() => setSelected(p)}>
                            {p.firstName} {p.lastName}
                          </button>
                          <small>#{p.id}</small>
                        </span>
                      </td>
                      <td>{p.email}</td>
                      <td>
                        {/* Named as on the member record; subscriber and day-pass follow purchases. */}
                        {[...p.roles.map(roleName), ...(p.automaticRoles ?? []).map((r) => `${roleName(r)} (automatic)`)].join(", ")}
                      </td>
                      <td>
                        <span className={`status-pill status-pill--${p.status === "active" ? "ok" : "neutral"}`}>
                          {accountWords(p.status)}
                        </span>
                      </td>
                      <td>
                        {p.accessStatus === "active" ? (
                          <span className="staff-directory__muted">No restriction</span>
                        ) : (
                          <span className="status-pill status-pill--warn">{accessWords(p.accessStatus)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">No members match “{search}”.</p>
          )}
        </KeptResults>
      ) : null}
      {users.data ? (
        <Pager offset={offset} nextOffset={users.data.nextOffset} busy={busy} onChange={(next) => turn(() => setOffset(next))} />
      ) : null}
      {selected ? (
        <MemberRecord
          key={selected.id}
          id={selected.id}
          name={`${selected.firstName} ${selected.lastName}`}
          plans={plans.data ?? []}
          timeZone={config.data?.timeZone ?? "America/New_York"}
          onChanged={users.reload}
          onClose={close}
          notice={
            checkout("returned") ? (
              <p role="status" className="form-notice mr-notice">Returned from Stripe. Confirmed purchases appear under Membership and Payments below; payment verification can take a moment.</p>
            ) : checkout("cancelled") ? (
              <p role="status" className="form-notice mr-notice">Checkout cancelled. No access was issued by returning from checkout.</p>
            ) : undefined
          }
          viewAs={{ onOpen: (person) => void openMemberAccount(person), busy: opening, error: openError }}
        />
      ) : null}
    </section>
  );
}
