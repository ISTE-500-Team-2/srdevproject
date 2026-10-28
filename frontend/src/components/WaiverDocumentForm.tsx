import { useId, useState, type ReactNode } from 'react';
import type { User, Waiver } from '../lib/contracts';
import { localInput } from '../lib/display';

export function WaiverDocumentForm({ waiver, user, busy, onSubmit, children }: {
  waiver: Waiver;
  user: User | null;
  busy: boolean;
  onSubmit: (values: Record<string, string>, guardianConsent: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  const today = localInput().slice(0, 10);
  const fields = waiver.formFields ?? [];
  const signerName = waiver.signerName ?? (user ? `${user.firstName} ${user.lastName}` : '');
  const firstGuardianField = fields.find(field => field.section === 'guardian')?.key;
  const [guardianConsent, setGuardianConsent] = useState(false);
  // Only member fields are typed and submitted; the server fills the rest at signing.
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields
    .filter(field => field.source !== 'server')
    .map(field => {
      let value = '';
      if (field.section !== 'guardian' && field.type === 'email') value = user?.email ?? '';
      if (field.type === 'date' && !/^date of birth$/i.test(field.label)) value = today;
      return [field.key, value];
    })));
  // What a server-filled field will say, shown read-only so members see the record.
  const recorded = (label: string) =>
    /^participant name$/i.test(label) ? signerName
      : /^waiver version$/i.test(label) ? waiver.version
      : /member id/i.test(label) && user ? String(user.id)
      : /staff witness/i.test(label) ? 'Not applicable (electronic acceptance)'
      : 'Recorded when you sign';

  return (
    <form className="stack-form waiver-document" onSubmit={event => {
      event.preventDefault();
      if (!busy) onSubmit(values, guardianConsent);
    }}>
      <p>Version {waiver.version}</p>
      <p>Complete the fields marked *. To sign, type your full name exactly as it appears on your account{signerName ? `: ${signerName}` : ''}. Your name, member ID, the waiver version and the signing time are recorded from your account when you submit.</p>
      {waiver.description.split(/\r?\n/).map((line, lineNumber) => {
        if (/^Method of Acceptance:/.test(line)) {
          return <fieldset key={lineNumber} className="waiver-acceptance-method" disabled>
            <legend>Method of Acceptance</legend>
            {['Electronic', 'In Person', 'Other'].map(method => (
              <label key={method} className="check-control">
                <input type="checkbox" checked={method === 'Electronic'} readOnly />
                <span aria-hidden="true" /> {method}
              </label>
            ))}
          </fieldset>;
        }
        const lineFields = fields.filter(field => field.line === lineNumber);
        if (!lineFields.length) {
          if (/^\d+\.\s|^Parent or Legal Guardian Consent$|^Administrative Record$/.test(line)) return <h3 key={lineNumber}>{line}</h3>;
          return line ? <p className="policy-text" key={lineNumber}>{line}</p> : null;
        }
        return <div key={lineNumber} className="waiver-document__fields">
          {lineFields.map(field => {
            const isGuardian = field.section === 'guardian';
            const required = field.required && (!isGuardian || guardianConsent);
            const inputId = `${id}-${field.key}`;
            if (field.source === 'server')
              return <div key={field.key}>
                <label className="waiver-document__field" htmlFor={inputId}>
                  <span>{field.label}</span>
                  <input id={inputId} type="text" value={isGuardian && !guardianConsent ? '' : recorded(field.label)}
                    readOnly aria-readonly="true" className="is-locked" tabIndex={-1} />
                </label>
              </div>;
            return <div key={field.key}>
              {field.key === firstGuardianField ? (
                <label className="check-control waiver-guardian-toggle">
                  <input type="checkbox" checked={guardianConsent} disabled={busy}
                    onChange={event => setGuardianConsent(event.target.checked)} />
                  <span aria-hidden="true" /> Include parent or legal guardian consent
                </label>
              ) : null}
              <label className="waiver-document__field" htmlFor={inputId}>
                <span>{field.label}{required ? ' *' : ''}</span>
                <input id={inputId} name={field.key} type={field.type} required={required}
                  maxLength={field.maxLength} value={values[field.key] ?? ''}
                  disabled={busy || (isGuardian && !guardianConsent)}
                  max={/^date of birth$/i.test(field.label) ? today : undefined}
                  placeholder={field.section === 'participant' && /signature/i.test(field.label) ? signerName : undefined}
                  autoComplete="off"
                  onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />
              </label>
            </div>;
          })}
        </div>;
      })}
      {children}
    </form>
  );
}
