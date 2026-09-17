/** Requirement IDs are sourced from the live team Drive sheet, not older Jira numbering. */
const headings = {
  account_created: 'Your account has been created',
  account_creation_failed: 'Account creation could not be completed',
  account_closed: 'Your account has been closed',
  waiver_signed: 'Your signed waiver copy',
  waiver_expiring: 'Your waiver is nearing expiration',
  certification_expiring: 'Your certification is nearing expiration',
  certification_granted: 'Your certification is confirmed',
  certification_revoked: 'Your certification has been revoked',
  certification_required: 'Training is required before booking',
  membership_renewal: 'Your membership renewal is approaching',
  membership_expiring: 'Your membership expiration or renewal is approaching',
  membership_confirmed: 'Your membership is confirmed',
  membership_issued: 'Your membership is confirmed',
  membership_cancelled: 'Your membership cancellation is confirmed',
  day_pass_confirmed: 'Your day pass is confirmed',
  day_pass_issued: 'Your day pass is confirmed',
  reservation_confirmed: 'Your reservation is confirmed',
  reservation_created: 'Your reservation is confirmed',
  reservation_cancelled: 'Your reservation cancellation is confirmed',
  studio_reservation_confirmed: 'Your studio reservation is confirmed',
  studio_reservation_cancelled: 'Your studio cancellation is confirmed',
  payment_receipt: 'Your payment receipt',
  payment_recorded: 'Your payment receipt',
  payment_status_changed: 'Your payment record has been updated',
  payment_refunded: 'Your refund is confirmed',
  payment_failed: 'Your payment could not be completed',
  refund_confirmed: 'Your refund is confirmed',
  system_issue: 'A studio service issue needs your attention',
  service_restored: 'Studio service has been restored',
  role_granted: 'Your studio role has been updated',
  admin_certification_revoked: 'Certification revocation recorded',
} as const;

export type NotificationKind = keyof typeof headings;
export const notificationKinds = Object.keys(headings) as NotificationKind[];
export type NotificationPayload = Record<string, unknown>;
export interface NotificationContext {
  recipientEmail: string;
  recipientName?: string;
  senderName: string;
  senderEmail: string;
  postalAddress: string;
  preferencesUrl?: string;
}
export interface RenderedNotification { subject: string; htmlContent: string; textContent: string }

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!);

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Only explicit, approved fields are rendered; arbitrary payloads may contain sensitive metadata. */
const detailFields = {
  resourceName: 'Resource', waiverName: 'Waiver', certificationName: 'Certification',
  membershipName: 'Membership', reservationId: 'Reservation', paymentId: 'Payment',
  amount: 'Amount', currency: 'Currency', startsAt: 'Starts', endsAt: 'Ends',
  expiresAt: 'Expires', renewsAt: 'Renews', timeZone: 'Time zone',
  reason: 'Reason', instructions: 'Next steps', role: 'Role',
  equipmentName: 'Equipment', location: 'Location', startTime: 'Starts', endTime: 'Ends',
  planName: 'Plan', validDate: 'Valid date', method: 'Payment method', reference: 'Reference',
  paidAt: 'Paid at',
} as const;

const dateFields = new Set(['startsAt', 'endsAt', 'expiresAt', 'renewsAt', 'startTime', 'endTime', 'paidAt', 'signedAt']);
function displayDate(value: string, timeZone: string): string {
  // Calendar-only dates (e.g. a day pass) are not UTC instants; do not shift them a day.
  if (!timeZone || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(date);
}

export function renderNotification(kind: NotificationKind, payload: NotificationPayload,
  context: NotificationContext): RenderedNotification {
  if (!Object.hasOwn(headings, kind)) throw new Error('Unsupported notification kind');
  for (const value of [context.recipientEmail, context.senderEmail, context.senderName, context.postalAddress]) {
    if (!value?.trim()) throw new Error('Notification identity and postal address are required');
  }
  const heading = headings[kind];
  const timeZone = text(payload.timeZone);
  const normalized = { ...payload };
  const sourceNameField = kind === 'waiver_expiring' ? 'waiverName' :
    kind === 'certification_expiring' ? 'certificationName' :
    kind === 'membership_expiring' || kind === 'membership_renewal' ? 'membershipName' : undefined;
  if (sourceNameField && !normalized[sourceNameField]) normalized[sourceNameField] = payload.name;
  const paragraphs = [
    `Hello ${context.recipientName || context.recipientEmail},`,
    heading + '.',
  ];
  for (const [field, label] of Object.entries(detailFields)) {
    const raw = text(normalized[field]);
    const value = dateFields.has(field) ? displayDate(raw, timeZone) : raw;
    if (value) paragraphs.push(`${label}: ${value}`);
  }
  if (kind === 'waiver_signed') {
    // FR-063 requires the actual immutable signed snapshot, never just current waiver text.
    const fullText = text(payload.waiverText);
    const signature = text(payload.signature);
    const signedAt = text(payload.signedAt);
    const version = text(payload.waiverVersion);
    if (!fullText || !signature || !signedAt || !version) {
      throw new Error('Signed waiver notification requires text, signature, timestamp and version');
    }
    paragraphs.push(`Waiver version: ${version}`, `Signed by: ${signature}`,
      `Signed at: ${displayDate(signedAt, timeZone)}`, `Signed waiver document:\n${fullText}`);
  }
  const identity = `From: ${context.senderName} <${context.senderEmail}>\nTo: ${context.recipientName || context.recipientEmail} <${context.recipientEmail}>`;
  paragraphs.push(`You can opt out of all notifications in your profile notification settings.`);
  let preferenceLink = '';
  if (context.preferencesUrl) {
    let url: URL;
    try { url = new URL(context.preferencesUrl); } catch { throw new Error('Invalid notification preferences URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid notification preferences URL');
    preferenceLink = url.href;
    paragraphs.push(`Notification preferences: ${preferenceLink}`);
  }
  paragraphs.push(context.senderName, context.postalAddress);
  const subject = `${context.senderName}: ${heading}`.replace(/[\r\n]+/g, ' ');
  const htmlContent = '<!doctype html><html lang="en"><body>' +
    `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(identity).replace(/\n/g, '<br>')}</p>` +
    paragraphs.map(p => `<p style="white-space:pre-wrap">${escapeHtml(p)}</p>`).join('') +
    (preferenceLink ? `<p><a href="${escapeHtml(preferenceLink)}">Manage notification preferences</a></p>` : '') +
    '</body></html>';
  return { subject, htmlContent, textContent: `${identity}\n\n${paragraphs.join('\n\n')}` };
}
