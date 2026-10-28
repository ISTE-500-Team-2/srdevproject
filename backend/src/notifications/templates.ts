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
  reservation_updated: 'Your reservation has been updated',
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

type Tone = 'success' | 'info' | 'warning' | 'danger';
interface Facts { item: string; money: string; range: string; role: string; date: string }
interface Copy {
  category: string;
  status: string;
  tone: Tone;
  intro: (facts: Facts) => string;
  cta?: readonly [label: string, path: string];
}

const membership = ['Manage membership', '/membership'] as const;
const certifications = ['View certifications', '/certifications'] as const;
const reservations = ['View my reservations', '/equipment'] as const;

/** Plain-text copy only; every value is escaped when the HTML is assembled. */
const copy: Record<NotificationKind, Copy> = {
  account_confirmation: { category: 'Account', status: 'Action needed', tone: 'warning',
    intro: () => 'Thanks for signing up. Confirm your email address to finish setting up your account.' },
  account_created: { category: 'Account', status: 'Ready', tone: 'success',
    intro: () => 'Your email is confirmed and your studio account is ready.', cta: ['Open my dashboard', '/'] },
  account_creation_failed: { category: 'Account', status: 'Not completed', tone: 'danger',
    intro: () => 'We couldn’t finish creating your account. Please try signing up again.', cta: ['Try again', '/login'] },
  account_closed: { category: 'Account', status: 'Closed', tone: 'info',
    intro: () => 'Your studio account has been closed. If you didn’t expect this, contact the studio.' },
  waiver_signed: { category: 'Waivers', status: 'Signed', tone: 'success',
    intro: () => 'Your agreement has been recorded. Keep the signed copy below for your records. You can also download it from your profile.',
    cta: ['View my signed waivers', '/profile'] },
  waiver_expiring: { category: 'Waivers', status: 'Expiring soon', tone: 'warning',
    intro: () => 'Your waiver expires soon. Sign it again to keep booking equipment and studios without a gap.',
    cta: ['Review waivers', '/certifications'] },
  certification_expiring: { category: 'Certifications', status: 'Expiring soon', tone: 'warning',
    intro: () => 'Your certification expires soon. Renew it to keep booking this equipment.', cta: certifications },
  certification_granted: { category: 'Certifications', status: 'Certified', tone: 'success',
    intro: () => 'You’re certified. You can now book this equipment.', cta: ['Book equipment', '/equipment'] },
  certification_revoked: { category: 'Certifications', status: 'Revoked', tone: 'danger',
    intro: () => 'Your certification has been revoked, so you can no longer book this equipment.', cta: certifications },
  certification_required: { category: 'Training', status: 'Training needed', tone: 'warning',
    intro: f => `You need to finish training before you can book ${f.item || 'this equipment'}.`, cta: ['See training', '/training'] },
  membership_renewal: { category: 'Membership', status: 'Renewal coming up', tone: 'warning',
    intro: () => 'Your membership is coming up for renewal.', cta: membership },
  membership_expiring: { category: 'Membership', status: 'Expiring soon', tone: 'warning',
    intro: () => 'Your membership expires soon. Renew it to keep your studio access.', cta: membership },
  membership_confirmed: { category: 'Membership', status: 'Active', tone: 'success',
    intro: () => 'You’re all set. Your membership details are below.', cta: membership },
  membership_issued: { category: 'Membership', status: 'Active', tone: 'success',
    intro: () => 'You’re all set. Your membership details are below.', cta: membership },
  membership_cancelled: { category: 'Membership', status: 'Cancelled', tone: 'info',
    intro: () => 'Your membership has been cancelled.', cta: membership },
  day_pass_confirmed: { category: 'Day pass', status: 'Confirmed', tone: 'success',
    intro: f => `Your day pass${f.date ? ` for ${f.date}` : ''} is ready.`, cta: ['View membership', '/membership'] },
  day_pass_issued: { category: 'Day pass', status: 'Confirmed', tone: 'success',
    intro: f => `Your day pass${f.date ? ` for ${f.date}` : ''} is ready.`, cta: ['View membership', '/membership'] },
  reservation_confirmed: { category: 'Equipment', status: 'Confirmed', tone: 'success',
    intro: f => `You’re booked${f.item ? ` on ${f.item}` : ''}${f.range ? ` for ${f.range}` : ''}.`, cta: reservations },
  reservation_created: { category: 'Equipment', status: 'Confirmed', tone: 'success',
    intro: f => `You’re booked${f.item ? ` on ${f.item}` : ''}${f.range ? ` for ${f.range}` : ''}.`, cta: reservations },
  reservation_updated: { category: 'Equipment', status: 'Updated', tone: 'info',
    intro: f => `Your ${f.item ? `${f.item} ` : ''}reservation has changed. The updated details are below.`, cta: reservations },
  reservation_cancelled: { category: 'Reservation', status: 'Cancelled', tone: 'info',
    intro: f => `Your ${f.item ? `${f.item} ` : ''}reservation has been cancelled.` },
  studio_reservation_confirmed: { category: 'Studio rental', status: 'Confirmed', tone: 'success',
    intro: f => `${f.item || 'Your studio'} is reserved for you${f.range ? `, ${f.range}` : ''}.`, cta: ['View my rental', '/studios'] },
  studio_reservation_cancelled: { category: 'Studio rental', status: 'Cancelled', tone: 'info',
    intro: f => `Your ${f.item || 'studio'} rental has been cancelled, and those dates are open for booking again.`,
    cta: ['Browse studios', '/studios'] },
  payment_receipt: { category: 'Payments', status: 'Paid', tone: 'success',
    intro: f => `Thanks, we’ve received your payment${f.money ? ` of ${f.money}` : ''}.` },
  payment_recorded: { category: 'Payments', status: 'Paid', tone: 'success',
    intro: f => `Thanks, we’ve received your payment${f.money ? ` of ${f.money}` : ''}.` },
  payment_status_changed: { category: 'Payments', status: 'Updated', tone: 'info',
    intro: () => 'There’s an update to one of your payments. The current details are below.' },
  payment_refunded: { category: 'Payments', status: 'Refunded', tone: 'success',
    intro: f => `Your refund${f.money ? ` of ${f.money}` : ''} has been issued to your original payment method.` },
  payment_failed: { category: 'Payments', status: 'Failed', tone: 'danger',
    intro: () => 'Your payment didn’t go through.' },
  refund_confirmed: { category: 'Payments', status: 'Refunded', tone: 'success',
    intro: f => `Your refund${f.money ? ` of ${f.money}` : ''} has been issued to your original payment method.` },
  system_issue: { category: 'Service notice', status: 'Service issue', tone: 'warning',
    intro: () => 'Some studio services aren’t working as expected right now.' },
  service_restored: { category: 'Service notice', status: 'Restored', tone: 'success',
    intro: () => 'Studio services are working normally again.' },
  role_granted: { category: 'Account', status: 'Updated', tone: 'info',
    intro: f => f.role ? `Your studio role is now ${f.role}.` : 'Your studio role has been updated.' },
  admin_certification_revoked: { category: 'Staff notice', status: 'Recorded', tone: 'info',
    intro: () => 'A certification revocation has been recorded.' },
};

const tones: Record<Tone, { ink: string; wash: string }> = {
  success: { ink: '#1d6b35', wash: '#e7f4ea' },
  info: { ink: '#6b4a2f', wash: '#f3ebe2' },
  warning: { ink: '#8a4b00', wash: '#fff0d6' },
  danger: { ink: '#a2312a', wash: '#fbe6e3' },
};

const methods: Record<string, string> = {
  manual: 'In person at the studio', stripe_test: 'Card (test mode)', cash: 'Cash',
  external_card: 'Card (paid in person)', bank_transfer: 'Bank transfer', unspecified: 'Recorded by staff', other: 'Recorded by staff',
};
const paymentStatuses: Record<string, string> = {
  unpaid: 'Not paid', paid: 'Paid', pending: 'Pending', waived: 'Waived', refund_pending: 'Refund in progress',
  refunded: 'Refunded', refund_failed: 'Refund failed',
};
const humanize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');

function money(amount: string, currency: string): string {
  if (!amount) return '';
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(value);
  } catch {
    return `${amount} ${currency}`.trim();
  }
}

// Calendar-only dates (e.g. a day pass) are not UTC instants; never shift them a day.
function moment(value: string, timeZone: string) {
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!calendar && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const date = new Date(calendar ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const zone = calendar ? 'UTC' : timeZone || 'UTC';
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options });
  return {
    day: format({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date),
    dayInYear: format({ weekday: 'short', month: 'short', day: 'numeric' }).format(date),
    year: format({ year: 'numeric' }).format(date),
    time: calendar ? '' : format({ hour: 'numeric', minute: '2-digit' }).format(date),
    zone: calendar ? '' : format({ timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '',
  };
}

function displayDate(value: string, timeZone: string): string {
  const m = moment(value, timeZone);
  return !m ? value : m.time ? `${m.day} at ${m.time} ${m.zone}` : m.day;
}

function displayRange(start: string, end: string, timeZone: string): string {
  const s = moment(start, timeZone);
  const e = moment(end, timeZone);
  if (s && e && s.day === e.day) return s.time ? `${s.day}, ${s.time} – ${e.time} ${e.zone}` : s.day;
  if (s && e && !s.time && !e.time) return `${s.year === e.year ? s.dayInYear : s.day} – ${e.day}`;
  return `${displayDate(start, timeZone)} – ${displayDate(end, timeZone)}`;
}

function safeUrl(value: string, error: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(error); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(error);
  return url;
}

const font = "'Barlow',Arial,Helvetica,sans-serif";
const p = (style: string, html: string) => `<p style="margin:0;${style}">${html}</p>`;

export function renderNotification(kind: NotificationKind, payload: NotificationPayload,
  context: NotificationContext): RenderedNotification {
  if (!Object.hasOwn(headings, kind)) throw new Error('Unsupported notification kind');
  for (const value of [context.recipientEmail, context.senderEmail, context.senderName, context.postalAddress]) {
    if (!value?.trim()) throw new Error('Notification identity and postal address are required');
  }
  const heading = headings[kind];
  const { category, status, tone, intro, cta } = copy[kind];
  const timeZone = text(payload.timeZone);
  const field = (name: string) => text(payload[name]);
  const preferenceLink = context.preferencesUrl ? safeUrl(context.preferencesUrl, 'Invalid notification preferences URL').href : '';

  /** Only explicit, approved fields are rendered; arbitrary payloads may contain sensitive metadata. */
  const currency = field('currency');
  const item = field('resourceName') || field('equipmentName');
  const start = field('startsAt') || field('startTime');
  const end = field('endsAt') || field('endTime');
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
  const range = start && end ? displayRange(start, end, timeZone) : '';
  const amount = money(field('amount'), currency);
  const facts: Facts = { item, money: amount, range, role: field('role'), date: field('validDate') && displayDate(field('validDate'), timeZone) };
  const sourceName = field('name');

  const rows: Array<[string, string]> = [];
  const row = (label: string, value: string) => { if (value) rows.push([label, value]); };
  if (kind === 'waiver_signed') {
    // FR-063 requires the actual immutable signed snapshot, never just current waiver text.
    // The completed copy (with the member's entries) when the waiver was a form.
    const fullText = field('completedWaiverText') || field('waiverText');
    const signature = field('signature');
    const signedAt = field('signedAt');
    const version = field('waiverVersion');
    if (!fullText || !signature || !signedAt || !version) {
      throw new Error('Signed waiver notification requires text, signature, timestamp and version');
    }
    row('Waiver', field('waiverName') || 'Signed agreement');
    row('Version', version);
    row('Signed by', signature);
    row('Signed at', displayDate(signedAt, timeZone));
  } else {
    row(kind.startsWith('studio_') ? 'Studio' : 'Equipment', item);
    row('Waiver', field('waiverName') || (kind === 'waiver_expiring' ? sourceName : ''));
    row('Certification', field('certificationName') || (kind === 'certification_expiring' ? sourceName : ''));
    row('Membership', field('membershipName') || (kind === 'membership_expiring' || kind === 'membership_renewal' ? sourceName : ''));
    row('Plan', field('planName'));
    row('Role', field('role'));
    row('Location', field('location'));
    if (range) row(allDay ? 'Dates' : 'When', range);
    else { row('Starts', start && displayDate(start, timeZone)); row('Ends', end && displayDate(end, timeZone)); }
    row('Date', facts.date);
    row('Expires', field('expiresAt') && displayDate(field('expiresAt'), timeZone));
    row('Renews', field('renewsAt') && displayDate(field('renewsAt'), timeZone));
    row('Booking', field('reservationId') && `#${field('reservationId')}`);
    row(kind.startsWith('studio_') ? 'Rental total' : kind === 'payment_refunded' || kind === 'refund_confirmed' ? 'Refund amount'
      : kind === 'payment_receipt' || kind === 'payment_recorded' ? 'Amount paid' : 'Amount', amount);
    row('Payment method', field('method') && (methods[field('method')] ?? field('method')));
    if (kind !== 'studio_reservation_cancelled')
      row('Payment status', field('paymentStatus') && (paymentStatuses[field('paymentStatus')] ?? humanize(field('paymentStatus'))));
    row('Paid on', field('paidAt') && displayDate(field('paidAt'), timeZone));
    row('Payment', field('paymentId') && `#${field('paymentId')}`);
    row('Reference', field('reference'));
    row('Reason', field('reason'));
  }

  const callouts: Array<{ title: string; body: string }> = [];
  if (kind === 'studio_reservation_cancelled' && field('refundAmount')) {
    const refund = money(field('refundAmount'), currency);
    const paid = field('paymentStatus');
    callouts.push(Number(field('refundAmount')) <= 0
      ? paid === 'paid'
        ? { title: 'No refund due', body: 'Under this studio’s cancellation policy, this booking isn’t eligible for a refund.' }
        : { title: 'No refund needed', body: 'No payment was collected for this rental, so there’s nothing to refund.' }
      : paid === 'refunded'
        ? { title: 'Refunded', body: `${refund} has been returned to your original payment method.` }
        : { title: 'Refund on its way', body: `We’re returning ${refund} to your original payment method. You’ll get a separate email once it’s done.` });
  }
  if (field('instructions')) callouts.push({ title: tone === 'danger' ? 'What to do next' : 'What happens next', body: field('instructions') });

  let action: { label: string; url: string } | undefined;
  const notes: string[] = [];
  if (kind === 'account_confirmation') {
    const link = safeUrl(field('confirmationUrl'), 'Invalid confirmation link');
    if (link.pathname !== '/confirm-email' || !/^#[A-Za-z0-9_-]{43}$/.test(link.hash)) throw new Error('Invalid confirmation link');
    action = { label: 'Confirm my email', url: link.href };
    const expiry = field('expiresAt');
    notes.push(`This link works once and expires ${expiry ? displayDate(expiry, timeZone) : '24 hours after you signed up'}.`,
      'Didn’t create this account? You can ignore this email.');
    rows.length = 0;
  } else if (cta && preferenceLink) {
    action = { label: cta[0], url: new URL(cta[1], preferenceLink).href };
  }

  const greeting = `Hi ${context.recipientName || 'there'},`;
  const lead = intro(facts);
  const recipient = context.recipientName ? `${context.recipientName} <${context.recipientEmail}>` : context.recipientEmail;
  const sentTo = `Sent to ${recipient} from ${context.senderName} <${context.senderEmail}>.`;
  const optOut = 'You can opt out of all notifications in your profile notification settings';
  const documentText = kind === 'waiver_signed' ? field('waiverText') : '';

  const textContent = [
    heading, greeting, lead,
    rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
    ...callouts.map(c => `${c.title}\n${c.body}`),
    documentText && `Signed waiver document:\n${documentText}`,
    action && `${action.label}: ${action.url}`,
    ...notes,
    ['--', context.senderName, context.postalAddress, sentTo, preferenceLink ? `${optOut}: ${preferenceLink}` : `${optOut}.`].join('\n'),
  ].filter(Boolean).join('\n\n');

  const e = escapeHtml;
  const t = tones[tone];
  const body = 'font-size:16px;line-height:1.6;color:#3d2f27';
  const htmlContent = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(heading)}</title>
<style>@media (max-width:480px){.email-pad{padding-left:20px!important;padding-right:20px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f7f4f0;color:#24150e;font-family:${font};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${e(lead)}${'&#8199;&#847;'.repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4f0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td class="email-pad" style="padding:22px 32px;background-color:#241006;border-bottom:4px solid #f7961d;border-radius:16px 16px 0 0;font-family:'Black Ops One','Arial Black',Arial,sans-serif;font-size:20px;letter-spacing:0.5px;color:#ffffff">${e(context.senderName)}</td></tr>
<tr><td class="email-pad" style="padding:32px;background-color:#ffffff;border:1px solid #e5dbd0;border-top:0;border-radius:0 0 16px 16px;font-family:${font}">
${p('margin-bottom:12px;font-size:12px;line-height:20px', `<span style="font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#685d57">${e(category)}</span>&nbsp;&nbsp;<span style="display:inline-block;padding:0 10px;border-radius:999px;background-color:${t.wash};color:${t.ink};font-weight:700;white-space:nowrap"><span style="display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background-color:${t.ink};vertical-align:1px"></span>${e(status)}</span>`)}
<h1 style="margin:0 0 20px;font-family:${font};font-size:26px;line-height:1.25;font-weight:700;color:#24150e">${e(heading)}</h1>
${p(`margin-bottom:12px;${body}`, e(greeting))}
${p(`margin-bottom:24px;${body}`, e(lead))}
${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:separate;background-color:#faf7f3;border:1px solid #ebe2d8;border-radius:12px">
${rows.map(([label, value], i) => {
    const rule = i ? 'border-top:1px solid #ebe2d8;' : '';
    return `<tr><td valign="top" width="38%" style="${rule}padding:12px 12px 12px 18px;font-size:14px;line-height:1.5;color:#685d57">${e(label)}</td><td valign="top" style="${rule}padding:12px 18px 12px 0;font-size:15px;line-height:1.5;font-weight:600;color:#24150e;overflow-wrap:anywhere;word-break:break-word">${e(value)}</td></tr>`;
  }).join('\n')}
</table>` : ''}
${callouts.map(c => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background-color:${tone === 'danger' ? '#fdf1ef' : '#fff7ea'};border-left:4px solid ${tone === 'danger' ? '#b73a2e' : '#f7961d'};border-radius:0 10px 10px 0"><tr><td style="padding:14px 18px">
${p('margin-bottom:4px;font-size:14px;line-height:1.5;font-weight:700;color:#24150e', e(c.title))}
${p('font-size:15px;line-height:1.55;color:#3d2f27;white-space:pre-wrap;overflow-wrap:anywhere', e(c.body))}
</td></tr></table>`).join('\n')}
${documentText ? `<h2 style="margin:0 0 12px;font-family:${font};font-size:18px;line-height:1.3;color:#24150e">Signed waiver document</h2>
<div style="margin:0 0 28px;padding:20px;border:1px solid #ebe2d8;border-radius:12px;font-size:14px;line-height:1.7;color:#3d2f27;white-space:pre-wrap;overflow-wrap:anywhere">${e(documentText)}</div>` : ''}
${action ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#2b1306" style="border-radius:10px;background-color:#2b1306;background-image:linear-gradient(135deg,#2b1306,#59300f)"><a href="${e(action.url)}" style="display:inline-block;padding:14px 24px;border:1px solid #4d250b;border-radius:10px;font-family:${font};font-size:16px;line-height:1.2;font-weight:700;color:#ffffff;text-decoration:none">${e(action.label)}</a></td></tr></table>` : ''}
${notes.map((note, i) => p(`margin-top:${i ? 6 : 20}px;font-size:14px;line-height:1.6;color:#685d57`, e(note))).join('\n')}
${kind === 'account_confirmation' && action ? `<div style="margin-top:24px;padding-top:20px;border-top:1px solid #ebe2d8">${p('margin-bottom:6px;font-size:13px;line-height:1.6;color:#685d57', 'Button not working? Copy this link into your browser:')}${p('font-size:12px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere', `<a href="${e(action.url)}" style="color:#8a4f06">${e(action.url)}</a>`)}</div>` : ''}
</td></tr>
<tr><td align="center" style="padding:24px 24px 0;font-family:${font};font-size:12px;line-height:1.7;color:#685d57">
${p('margin-bottom:6px', `<strong style="color:#24150e">${e(context.senderName)}</strong> · ${e(context.postalAddress)}`)}
${p('margin-bottom:6px', e(sentTo))}
${p('', `You can opt out of all notifications in your profile.${preferenceLink ? ` <a href="${e(preferenceLink)}" style="color:#8a4f06;font-weight:600">Manage notification preferences</a>` : ''}`)}
</td></tr></table></td></tr></table></body></html>`;

  const subject = `${context.senderName}: ${heading}`.replace(/[\r\n]+/g, ' ');
  return { subject, htmlContent, textContent };
}
