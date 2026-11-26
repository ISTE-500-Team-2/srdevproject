import { LifeBuoy, Mail, Phone } from "lucide-react";
import type { UserProfile } from "../../lib/contracts";
import { formatPhone } from "./phone";

export function HelpSection({ profile }: { profile: UserProfile | null }) {
  const contact = profile?.studioContact;
  return (
    <section id="help" className="account-help" aria-labelledby="help-title">
      <span className="account-help__icon">
        <LifeBuoy aria-hidden="true" />
      </span>
      <div>
        <h2 id="help-title" tabIndex={-1}>
          Need a hand?
        </h2>
        <p>
          Contact {contact?.name ?? "the studio"} with any questions about your account.
        </p>
      </div>
      {contact ? (
        <div className="account-help__actions">
          <a className="button" href={`mailto:${contact.email}`}>
            <Mail aria-hidden="true" /> {contact.email}
          </a>
          {contact.phone ? (
            <a className="button" href={`tel:${contact.phone}`}>
              <Phone aria-hidden="true" /> {formatPhone(contact.phone)}
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
