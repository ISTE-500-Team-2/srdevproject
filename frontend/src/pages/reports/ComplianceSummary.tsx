import { CircleAlert, CircleCheck } from "lucide-react";
import type { Report } from "../../lib/reportContracts";
import { plural } from "./format";

/** Records that need a decision come first, each named so staff know what to fix. */
export function ComplianceSummary({ compliance: c }: { compliance: Report["compliance"] }) {
  const warnings: string[] = [];
  if (c.restrictedAccounts) warnings.push(`${plural(c.restrictedAccounts, "account is", "accounts are")} restricted.`);
  if (c.expiredTraining)
    warnings.push(`${plural(c.expiredTraining, "expired training record is", "expired training records are")} still marked active.`);
  if (c.trainingWithoutExpiry)
    warnings.push(
      `${plural(c.trainingWithoutExpiry, "active training record never expires", "active training records never expire")}. Add an expiry date to the certification.`,
    );
  if (c.signaturesWithoutCopy)
    warnings.push(`${plural(c.signaturesWithoutCopy, "signed waiver is missing its saved copy", "signed waivers are missing their saved copy")}.`);
  if (c.machinesWithoutTraining.length)
    warnings.push(
      `${plural(c.machinesWithoutTraining.length, "bookable machine has", "bookable machines have")} no training requirement: ${c.machinesWithoutTraining.join(", ")}.`,
    );
  const fine = [
    plural(c.activeMemberships, "active membership", "active memberships"),
    plural(c.activeAccounts, "active account", "active accounts"),
    c.restrictedAccounts ? "" : "no restricted accounts",
    c.expiredTraining ? "" : "no expired training",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      {warnings.length ? (
        <ul className="reports-checks">
          {warnings.map((text) => (
            <li key={text}>
              <CircleAlert aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="reports-allclear">
          <CircleCheck aria-hidden="true" />
          All clear.
        </p>
      )}
      <p className="reports-note">{fine}</p>
    </>
  );
}
