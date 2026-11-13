import { Info } from "lucide-react";
import type { Audit, Entitlement, MemberRequirements, Payment, Person } from "../../../lib/staffContracts";
import { needs, type NeedItem } from "./recordModel";
import { ROW_ICONS, type OpenDialog } from "./recordParts";

/** What needs a staff member on this record, each with the step that settles it; nothing when all is well. */
export function RecordNeeds({
  person,
  req,
  audit,
  memberships,
  payments,
  canManage,
  open,
  go,
}: {
  person: Person;
  req: MemberRequirements | null;
  audit: Audit[];
  memberships: Entitlement[];
  payments: Payment[];
  canManage: boolean;
  open: OpenDialog;
  go: (path: string) => void;
}) {
  const todo = needs({ person, req, audit, memberships, payments, canManage });
  const runNeed = (n: NeedItem) => {
    const a = n.action;
    if (a.kind === "link") go(a.href);
    else if (a.kind === "sell") open({ kind: "sell" });
    else if (a.kind === "renew") open({ kind: "sell", renewal: a.item });
    else if (a.kind === "entitlement") open({ kind: "entitlement", item: a.item, entitlementKind: "membership" });
    else if (a.kind === "payment") open({ kind: "payment", payment: a.payment });
    else open({ kind: "sponsor" });
  };
  if (!todo.length) return null;
  return (
    <section className="today-panel" aria-labelledby={`mr-needs-title-${person.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-needs-title-${person.id}`}>Needs you</h2>
        <span className="today-count today-count--hot">{todo.length}</span>
      </div>
      {todo.map((n) => {
        const Icon = ROW_ICONS[n.icon] ?? Info;
        return (
          <div className="today-todo" key={n.id}>
            <span className={`today-todo-icon${n.alert ? " today-todo-icon--alert" : ""}`}>
              <Icon aria-hidden="true" />
            </span>
            <div>
              <span className="today-todo-title">{n.title}</span>
              <p className="today-todo-detail">{n.detail}</p>
              <button type="button" className="today-button" onClick={() => runNeed(n)}>
                {n.action.label}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
