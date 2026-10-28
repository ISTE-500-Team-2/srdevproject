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
  const now = localInput();
  const today = now.slice(0, 10);
  const fields = waiver.formFields ?? [];
  const firstGuardianField = fields.find(field => field.section === 'guardian')?.key;
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => {
    let value = '';
    if (field.section !== 'guardian') {
      if (/^participant name$/i.test(field.label)) value = user ? `${user.firstName} ${user.lastName}` : '';
      if (field.type === 'email') value = user?.email ?? '';
      if (/^waiver version$/i.test(field.label)) value = waiver.version;
      if (/^user\/member id$/i.test(field.label)) value = String(user?.id ?? '');
    }
    if (field.type === 'date' && !/^date of birth$/i.test(field.label)) value = today;
    if (field.type === 'datetime-local') value = now;
    return [field.key, value];
  })));

  return (
    <form className="stack-form waiver-document" onSubmit={event => {
      event.preventDefault();
      if (!busy) onSubmit(values, guardianConsent);
    }}>
      <p>Version {waiver.version}</p>
      <p>Complete the fields marked *. Type your full name in the signature field. Your account and signing time are recorded when you submit.</p>
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
