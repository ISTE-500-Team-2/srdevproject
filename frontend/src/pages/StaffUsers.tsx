import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadState, Pager } from "../components/Management";
import { Modal } from "../components/Modal";
import { UserDetail } from "../components/staff/UserDetail";
import { statusLabel } from "../lib/display";
import type { Page, Person, Plan } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

/** Staff directory: a searchable table; a member's record opens beside it. */
export function StaffUsers() {
  const [input, setInput] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Person | null>(null);
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
    config = useApi<{ timeZone: string }>("/config");
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
          <div className="staff-directory__table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Account</th>
                  <th>Access</th>
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
        <Modal
          open
          width="panel"
          title={`${selected.firstName} ${selected.lastName}`}
          onClose={() => setSelected(null)}
        >
          <UserDetail
            key={selected.id}
            id={selected.id}
            plans={plans.data ?? []}
            timeZone={config.data?.timeZone ?? "America/New_York"}
            onChanged={users.reload}
          />
        </Modal>
      ) : null}
    </section>
  );
}
