import { ChevronRight } from "lucide-react";
import type { SupervisionSummary } from "../../../lib/contracts";
import type { Person } from "../../../lib/staffContracts";
import type { OpenDialog } from "./recordParts";

/** A minor's sponsoring adult and whether they are in the building; the sponsor can't change mid-visit. */
export function RecordSponsor({
  person: u,
  supervision,
  sponsorHere,
  canManage,
  open,
}: {
  person: Pick<Person, "id" | "firstName">;
  supervision: Pick<SupervisionSummary, "sponsor" | "visit">;
  sponsorHere: boolean;
  canManage: boolean;
  open: OpenDialog;
}) {
  const first = u.firstName;
  const visit = supervision.visit;
  return (
    <section className="today-panel" id={`mr-sponsor-${u.id}`} aria-labelledby={`mr-sp-title-${u.id}`}>
      <div className="today-panel-head">
        <h2 id={`mr-sp-title-${u.id}`}>Sponsoring adult</h2>
        {canManage && !visit ? (
          <button type="button" className="today-link" onClick={() => open({ kind: "sponsor" })}>
            {supervision.sponsor ? "Change" : "Link one"} <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {supervision.sponsor ? (
        <div className="mr-sponsor">
          <span className="today-avatar today-avatar--2" aria-hidden="true">
            {supervision.sponsor.name
              .split(" ")
              .map((w) => w[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <span className="today-who-text">
            <span className="today-who-name">{supervision.sponsor.name}</span>
            <span className="today-who-place">{sponsorHere ? "In the building now" : "Not checked in"}</span>
          </span>
        </div>
      ) : (
        <p className="today-empty">No adult is linked yet. {first} can’t check in without one.</p>
      )}
      {visit && supervision.sponsor ? <p className="today-empty mr-tight">To change the sponsor, check {first} out first.</p> : null}
    </section>
  );
}
