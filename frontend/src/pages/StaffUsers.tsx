import { useState } from "react";
import { LoadState, Pager } from "../components/Management";
import { UserDetail } from "../components/staff/UserDetail";
import type { Page, Person, Plan } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

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
