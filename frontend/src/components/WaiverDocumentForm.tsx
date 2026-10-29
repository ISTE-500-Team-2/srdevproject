import { useId, useState, type ReactNode } from 'react';
import type { User, Waiver, WaiverFormField } from '../lib/contracts';
import { localInput } from '../lib/display';

function fieldGuidance(field: WaiverFormField, signerName: string) {
  const label = field.label.toLowerCase();
  const guardian = field.section === 'guardian';
  if (/signature/.test(label)) return {
    hint: guardian ? 'Type the same full name entered in Parent/Guardian Name. This is your electronic signature.'
      : `Type ${signerName || 'your full account name'} to sign electronically. Use your full name, not initials.`,
    placeholder: guardian ? 'Parent or guardian’s full name' : signerName,
    autoComplete: 'off',
  };
  if (/date of birth/.test(label)) return { hint: 'Enter the participant’s date of birth, not today’s date.', autoComplete: 'bday' };
  if (/emergency contact name/.test(label)) return { hint: 'Who should we contact in an emergency? Enter their full name.', placeholder: 'Emergency contact’s full name', autoComplete: 'off' };
  if (/relationship/.test(label)) return { hint: 'How is the parent or guardian related to the participant?', placeholder: 'For example: parent or legal guardian', autoComplete: 'off' };
  if (field.type === 'tel') return { hint: guardian ? 'A phone number where the parent or guardian can be reached.' : /emergency/.test(label) ? 'A phone number where your emergency contact can be reached. Include the area code.' : 'Enter your phone number, including the area code.', placeholder: 'For example: (555) 010-1234', autoComplete: guardian ? 'section-guardian tel' : /emergency/.test(label) ? 'off' : 'section-participant tel' };
  if (field.type === 'email') return { hint: guardian ? 'Enter the parent or guardian’s email address.' : 'Check the email address from your account and update it here if needed.', placeholder: 'name@example.com', autoComplete: guardian ? 'section-guardian email' : 'section-participant email' };
  if (/guardian name/.test(label)) return { hint: 'Enter the full name of the parent or legal guardian who will sign.', placeholder: 'Parent or guardian’s full name', autoComplete: 'section-guardian name' };
  return { hint: 'Enter the information requested above.', autoComplete: 'off' };
}

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
      <div className="waiver-document__intro">
        <h3>Review and complete your agreement</h3>
        <p>Read the agreement, complete the required fields, then type your full name to sign. Your signature must match your account name{signerName ? `: ${signerName}` : ''}.</p>
        <p>Details labelled “Recorded automatically” are supplied from your account or recorded when you sign.</p>
      </div>
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
          {lineFields.some(field => field.key === firstGuardianField) ? (
            <div className="waiver-document__guardian">
              <label className="check-control waiver-guardian-toggle">
                <input type="checkbox" checked={guardianConsent} disabled={busy}
                  onChange={event => setGuardianConsent(event.target.checked)} />
                <span aria-hidden="true" /> Include parent or legal guardian consent
              </label>
              <p>Complete this section if guardian consent is required under The Collaboratory’s age policy. The parent or guardian provides their own details and signature.</p>
            </div>
          ) : null}
          {lineFields.map(field => {
            const isGuardian = field.section === 'guardian';
            const required = field.required && (!isGuardian || guardianConsent);
            const inputId = `${id}-${field.key}`;
            if (field.source === 'server')
              return <div key={field.key} hidden={isGuardian && !guardianConsent} className="waiver-document__recorded">
                <label htmlFor={inputId}>{field.label} <small>Recorded automatically</small></label>
                <output id={inputId}>{recorded(field.label)}</output>
              </div>;
            const guidance = fieldGuidance(field, signerName);
            const displayLabel = isGuardian && /^(phone|email)$/i.test(field.label) ? `Parent/guardian ${field.label.toLowerCase()}` : field.label;
            return <div key={field.key} hidden={isGuardian && !guardianConsent}>
              <label className="waiver-document__field" htmlFor={inputId}>
                <span>{displayLabel} <small>{required ? '(required)' : '(optional)'}</small></span>
                <input id={inputId} name={field.key} type={field.type} required={required}
                  aria-describedby={`${inputId}-help`}
                  maxLength={field.maxLength} value={values[field.key] ?? ''}
                  disabled={busy || (isGuardian && !guardianConsent)}
                  max={/^date of birth$/i.test(field.label) ? today : undefined}
                  placeholder={guidance.placeholder}
                  autoComplete={guidance.autoComplete}
                  onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />
              </label>
              <small id={`${inputId}-help`} className="waiver-document__hint">{guidance.hint}</small>
            </div>;
          })}
        </div>;
      })}
      {children}
    </form>
  );
}
