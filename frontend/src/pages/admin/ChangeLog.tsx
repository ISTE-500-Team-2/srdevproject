import { useState } from "react";
import { AuditList, LoadState, Pager } from "../../components/Management";
import { MemberSelect } from "../../components/MemberSelect";
import type { Audit, Page } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";

export function ChangeLog() {
  const [offset, setOffset] = useState(0),
    [filters, setFilters] = useState({
      userId: "",
      actorId: "",
      action: "",
      from: "",
      to: "",
    });
  const query = new URLSearchParams({ offset: String(offset) });
  if (filters.userId) query.set("userId", filters.userId);
  if (filters.actorId) query.set("actorId", filters.actorId);
  if (filters.action) query.set("action", filters.action);
  if (filters.from) query.set("from", new Date(filters.from).toISOString());
  if (filters.to) query.set("to", new Date(filters.to).toISOString());
  const records = useApi<Page<Audit>>(
    `/admin/audit?${query.toString()}`,
  );
  return (
    <section>
      <h2>Staff change log</h2>
      <p>
        Search recorded changes by user, action, and time.
      </p>
      <form
        className="management-search"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setFilters({
            userId: String(form.get("userId") ?? ""),
            actorId: String(form.get("actorId") ?? ""),
            action: String(form.get("action") ?? "").trim(),
            from: String(form.get("from") ?? ""),
            to: String(form.get("to") ?? ""),
          });
          setOffset(0);
        }}
      >
        <MemberSelect name="userId" label="Person changed" required={false} />
        <MemberSelect name="actorId" label="Changed by" required={false} />
        <label>
          Action <input name="action" placeholder="user.role_changed" />
        </label>
        <label>
          From <input name="from" type="datetime-local" />
        </label>
        <label>
          To <input name="to" type="datetime-local" />
        </label>
        <button className="button button--quiet">Search changes</button>
      </form>
      <LoadState {...records} />
      {records.data ? (
        <>
          <AuditList items={records.data.items} />
          <Pager
            offset={offset}
            nextOffset={records.data.nextOffset}
            onChange={setOffset}
          />
        </>
      ) : null}
    </section>
  );
}
