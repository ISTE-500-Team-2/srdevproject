import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { isProtectedAccount, rememberAccount } from "../components/admin/people";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../lib/api";
import { LoadState, Pager } from "../components/Management";
import { MemberRecord } from "../components/staff/record/MemberRecord";
import { statusLabel } from "../lib/display";
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
  const close = () => {
    setSelected(null);
    setOpenError("");
    if (params.has("member")) {
      const next = new URLSearchParams(params);
      next.delete("member");
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
    { retainOnReload: true, refreshInterval: 5000 },
  );
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
      <LoadState {...users} loading={users.loading && !users.data} />
      {users.data ? (
        users.data.items.length ? (
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
                      <button type="button" onClick={() => setSelected(p)}>
                        {p.firstName} {p.lastName}
                      </button>
                      <small>#{p.id}</small>
                    </td>
                    <td>{p.email}</td>
                    <td>{p.roles.map((r) => statusLabel(r)).join(", ")}</td>
                    <td>
                      <span className={`status-pill status-pill--${p.status === "active" ? "ok" : "neutral"}`}>
                        {statusLabel(p.status)}
                      </span>
                    </td>
                    <td>
                      {p.accessStatus === "active" ? (
                        <span className="staff-directory__muted">No restriction</span>
                      ) : (
                        <span className="status-pill status-pill--warn">{statusLabel(p.accessStatus)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No members match “{search}”.</p>
        )
      ) : null}
      {users.data ? (
        <Pager offset={offset} nextOffset={users.data.nextOffset} onChange={setOffset} />
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
            params.get("billing") === "returned" || params.get("pass") === "returned" ? (
              <p role="status" className="form-notice mr-notice">Returned from Stripe. Confirmed purchases appear under Membership and Payments below; payment verification can take a moment.</p>
            ) : params.get("billing") === "cancelled" || params.get("pass") === "cancelled" ? (
              <p role="status" className="form-notice mr-notice">Checkout cancelled. No access was issued by returning from checkout.</p>
            ) : undefined
          }
          viewAs={
            isProtectedAccount(selected) || selected.status !== "active" || selected.accessStatus !== "active"
              ? undefined
              : { onOpen: () => void openMemberAccount(selected), busy: opening, error: openError }
          }
        />
      ) : null}
    </section>
  );
}
