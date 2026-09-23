/** Requirement IDs are sourced from the live team Drive sheet, not older Jira numbering. */
const headings = {
  account_confirmation: 'Confirm your email address',
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
  if (kind === 'account_confirmation') {
    const link = new URL(text(payload.confirmationUrl));
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || link.pathname !== '/confirm-email' || !/^#[A-Za-z0-9_-]{43}$/.test(link.hash))
      throw new Error('Invalid confirmation link');
    paragraphs.push(`Confirm your email: ${link.href}`, 'This single-use link expires in 24 hours. Open it and choose Confirm email to finish signing in.');
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
  let htmlContent = '<!doctype html><html lang="en"><body>' +
    `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(identity).replace(/\n/g, '<br>')}</p>` +
    paragraphs.map(p => `<p style="white-space:pre-wrap">${escapeHtml(p)}</p>`).join('') +
    (kind === 'account_confirmation' ? `<p><a href="${escapeHtml(text(payload.confirmationUrl))}">Confirm email</a></p>` : '') +
    (preferenceLink ? `<p><a href="${escapeHtml(preferenceLink)}">Manage notification preferences</a></p>` : '') +
    '</body></html>';
  if (kind === 'account_confirmation') {
    const link = escapeHtml(text(payload.confirmationUrl));
    const name = escapeHtml(context.recipientName || 'there');
    const sender = escapeHtml(context.senderName);
    const expiry = text(payload.expiresAt);
    const expiryLabel = expiry ? escapeHtml(displayDate(expiry, timeZone)) : '24 hours after you signed up';
    htmlContent = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm your email</title></head>
<body style="margin:0;padding:0;background-color:#f5f2ed;color:#292018;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">One quick step to finish setting up your account.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f2ed"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border:1px solid #ddd4c8;border-radius:12px">
<tr><td style="padding:24px 28px;background-color:#291607;color:#ffffff;border-radius:12px 12px 0 0;font-size:19px;font-weight:bold">${sender}</td></tr>
<tr><td style="padding:32px 28px">
<p style="margin:0 0 12px;color:#876022;font-size:12px;font-weight:bold;letter-spacing:1px">WELCOME TO THE STUDIO</p>
<h1 style="margin:0 0 24px;font-size:28px;line-height:1.25;color:#292018">One last step: confirm your email.</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6">Hi ${name},</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">Thanks for creating your account. Open the link below, then choose <strong>Confirm email</strong> to finish signing in.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#a85d00" style="border-radius:6px"><a href="${link}" style="display:inline-block;padding:16px 24px;border:1px solid #a85d00;border-radius:6px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold">Confirm my email</a></td></tr></table>
<p style="margin:24px 0 8px;font-size:14px;line-height:1.6;color:#63584e">This link works once and expires ${expiryLabel}.</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#63584e">Didn’t create this account? You can ignore this email.</p>
<div style="border-top:1px solid #e7dfd4;padding-top:20px"><p style="margin:0 0 8px;font-size:13px;color:#63584e">Button not working? Copy this link into your browser:</p><p style="margin:0;font-size:12px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere"><a href="${link}" style="color:#754500">${link}</a></p></div>
</td></tr>
<tr><td style="padding:20px 28px;background-color:#faf8f5;border-top:1px solid #e7dfd4;font-size:12px;line-height:1.7;color:#63584e">
<p style="margin:0 0 8px">From: ${sender} &lt;${escapeHtml(context.senderEmail)}&gt;<br>To: ${escapeHtml(context.recipientName || context.recipientEmail)} &lt;${escapeHtml(context.recipientEmail)}&gt;</p>
<p style="margin:0 0 8px">${sender}<br>${escapeHtml(context.postalAddress)}</p>
<p style="margin:0">You can opt out of all notifications in your profile.${preferenceLink ? ` <a href="${escapeHtml(preferenceLink)}" style="color:#754500">Notification preferences</a>` : ''}</p>
</td></tr></table></td></tr></table></body></html>`;
  }
  return { subject, htmlContent, textContent: `${identity}\n\n${paragraphs.join('\n\n')}` };
}
