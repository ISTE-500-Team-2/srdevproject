import { Lock } from "lucide-react";
import type { Person } from "../../../lib/staffContracts";
import { accessWords, accountWords, phoneText, roleName } from "./recordModel";
import type { OpenDialog } from "./recordParts";

/** The account settings staff change from the record, each locked with the reason when this viewer may not. */
export function RecordAccount({
  person: u,
  locked,
  self,
  isAdmin,
  open,
}: {
  person: Person;
  /** Why every setting is locked for this viewer, or empty. */
  locked: string;
  /** The viewer is this member. */
  self: boolean;
  isAdmin: boolean;
  open: OpenDialog;
}) {
  return (
    <section className="today-panel" id={`mr-account-${u.id}`} aria-labelledby={`mr-acc-title-${u.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-acc-title-${u.id}`}>Account</h2>
      </div>
      <dl className="mr-facts">
        <Fact
          label="Account status"
          value={accountWords(u.status)}
          bad={u.status !== "active"}
          small={u.status !== "active" && u.accountReason ? `“${u.accountReason}”` : ""}
          lock={locked || (self ? "You can’t change your own status." : "")}
          onChange={() => open({ kind: "status" })}
        />
        <Fact
          label="Facility access"
          value={accessWords(u.accessStatus)}
          bad={u.accessStatus !== "active"}
          small={u.accessStatus !== "active" && u.accessReason ? `“${u.accessReason}”` : ""}
          lock={locked || (self ? "You can’t change your own access." : "")}
          onChange={() => open({ kind: "access" })}
        />
        <Fact
          label="Roles"
          value={roleName(u.primaryRole ?? u.roles[0] ?? "member")}
          small={[
            u.roles.filter((r) => r !== u.primaryRole).map(roleName).join(", ") ? `Also ${u.roles.filter((r) => r !== u.primaryRole).map(roleName).join(", ")}` : "",
            u.isStudent ? "Student" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          lock={locked || (self ? "Another administrator has to change your roles." : !isAdmin ? "Only administrators change roles." : "")}
          onChange={() => open({ kind: "roles" })}
        />
        <Fact
          label="Conduct flag"
          value={u.conductFlag ? "On" : "Off"}
          bad={u.conductFlag}
          lock={locked || (self ? "Another administrator has to change your conduct flag." : "")}
          onChange={() => open({ kind: "conduct" })}
        />
        <Fact
          label="Name & phone"
          value={`${u.firstName} ${u.lastName}`}
          small={u.phone ? phoneText(u.phone) : "No phone on file"}
          lock={locked}
          edit
          onChange={() => open({ kind: "profile" })}
        />
      </dl>
    </section>
  );
}

function Fact({
  label,
  value,
  small,
  bad = false,
  lock,
  edit = false,
  onChange,
}: {
  label: string;
  value: string;
  small?: string;
  bad?: boolean;
  lock: string;
  edit?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="mr-fact">
      <dt>{label}</dt>
      <dd className={bad ? "is-bad" : undefined}>
        {value}
        {small ? <small>{small}</small> : null}
        {lock ? (
          <span className="mr-lock">
            <Lock aria-hidden="true" />
            {lock}
          </span>
        ) : null}
      </dd>
      {lock ? null : (
        <button type="button" className="today-link" onClick={onChange} aria-label={`${edit ? "Edit" : "Change"} ${label.toLowerCase()}`}>
          {edit ? "Edit" : "Change"}
        </button>
      )}
    </div>
  );
}
