import { Pencil } from "lucide-react";
import { LoadState } from "../../components/Management";
import type { LiveEquipment } from "../../lib/contracts";
import { cents } from "../../lib/display";
import type { ComplianceReport } from "../../lib/staffContracts";
import type { Course, Loaded } from "./trainingTypes";

/** The certification cards: price, renewal, linked equipment and how many members are current. */
export function CertificationCatalog({
  catalog,
  equipment,
  compliance,
  canConfigure,
  onEdit,
}: {
  catalog: Loaded<Course[]>;
  equipment: LiveEquipment[] | null;
  compliance: ComplianceReport | null;
  canConfigure: boolean;
  onEdit: (course: Course) => void;
}) {
  const certified = new Map((compliance?.certificationBreakdown ?? []).map((c) => [c.id, c]));
  const equipmentName = (id: number) => equipment?.find((e) => e.id === id)?.name ?? "Equipment";
  return (
    <>
      <LoadState {...catalog} loading={catalog.loading && !catalog.data} />
      {catalog.data && !catalog.data.length ? (
        <p className="cw-muted">No certifications yet.{canConfigure ? " Add one to link training to equipment." : ""}</p>
      ) : null}
      <div className="cw-certs">
        {catalog.data?.map((c) => {
          const n = certified.get(c.id);
          return (
            <article className="cw-cert" key={c.id}>
              <div className="cw-cert__top">
                <h3>{c.name}</h3>
                {n ? (
                  <span className={`cw-tag cw-tag--${n.compliant ? "green" : "grey"}`}>{n.compliant} certified</span>
                ) : null}
              </div>
              {c.trainingMinutes != null && c.trainingFeeCents != null ? (
                <p className="cw-muted">{c.trainingMinutes} minutes · {cents(c.trainingFeeCents)} training fee</p>
              ) : null}
              {c.validityDays ? (
                <small className="cw-muted">Renew every {c.validityDays} days</small>
              ) : (
                <small className="cw-muted">Valid until revoked{c.endsAt ? ' or the certification ends' : ''}</small>
              )}
              <p>{c.trainingMinutes ?? 60} minutes of training · {c.trainingFeeCents == null ? 'Training fee not configured' : `${cents(c.trainingFeeCents)} one-time fee when registering for training`}</p>
              <div className="cw-cert__equipment">
                {c.equipmentIds.length ? (
                  c.equipmentIds.map((id) => (
                    <span className="cw-tag cw-tag--grey" key={id}>
                      {equipmentName(id)}
                    </span>
                  ))
                ) : (
                  <small className="cw-muted">No equipment linked</small>
                )}
              </div>
              <div className="cw-cert__foot">
                <small className="cw-muted">
                  {n ? (n.expiring ? `${n.expiring} expiring soon` : n.compliant ? "All current" : "No one trained yet") : ""}
                </small>
                {canConfigure ? (
                  <button type="button" className="button button--quiet cw-small" onClick={() => onEdit(c)} aria-label={`Configure ${c.name}`}>
                    <Pencil aria-hidden="true" /> Edit
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
