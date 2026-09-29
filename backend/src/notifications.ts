
export type NotificationKey =
  | 'accountCreation'
  | 'accountCreationFailed'
  | 'waiverSigned'
  | 'reservationConfirmed'
  | 'reservationCancelled'
  | 'studioCancellation'
  | 'paymentReceipt'
  | 'transactionFailed'
  | 'systemIssue'
  | 'refundIssued'
  | 'dayPassIssued'
  | 'membershipIssued';

export type NotificationVariables = Record<string, string | number | undefined>;

export interface NotificationTemplate {
  subject: string;
  body: string;
}

const BRANDING = `The Crafty Studio
1449 Wiseburg Road, White Hall, Maryland 21161
arborcollaboratory@yahoo.com`;

const interpolate = (template: string, variables: NotificationVariables) =>
  template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => {
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });

export const notificationTemplates: Record<
  NotificationKey,
  NotificationTemplate
> = {
  accountCreation: {
    subject:
      '{{firstName}}, welcome to The Crafty Studio - your account is ready',
    body: `Hello {{firstName}},

Welcome to The Crafty Studio! Your studio account has been created successfully.

Your account email: {{email}}

We are excited to help you reserve equipment, sign waivers, and make the most of your studio time.

Best,
${BRANDING}`,
  },
  accountCreationFailed: {
    subject: 'We could not create your The Crafty Studio account',
    body: `Hello {{firstName}},

We could not create your The Crafty Studio account for {{email}}.

Reason: {{reason}}

Please review your information and try again, or contact the studio team if you need help.

Best,
${BRANDING}`,
  },
  waiverSigned: {
    subject: '{{firstName}}, your signed waiver is on file at The Crafty Studio',
    body: `Hello {{firstName}},

This message confirms that your signed waiver, {{waiverName}}, has been received and stored by The Crafty Studio.

Your signed waiver was recorded on {{signatureDate}}. You can review the signed policy from your Certifications & waivers account records.

Thank you for keeping your account current and safe.

Best,
${BRANDING}`,
  },
  reservationConfirmed: {
    subject: '{{firstName}}, your reservation is confirmed at The Crafty Studio',
    body: `Hello {{firstName}},

Your reservation has been confirmed at The Crafty Studio.

Reservation ID: {{reservationId}}
Equipment: {{equipmentName}}
Status: Confirmed

We look forward to seeing you soon.

Best,
${BRANDING}`,
  },
  reservationCancelled: {
    subject:
      '{{firstName}}, your The Crafty Studio reservation has been cancelled',
    body: `Hello {{firstName}},

This notice confirms that your reservation at The Crafty Studio has been cancelled.

Reservation ID: {{reservationId}}
Resource: {{resourceName}}
Status: Cancelled

If this change was unexpected, please contact the studio team for assistance.

Best,
${BRANDING}`,
  },
  studioCancellation: {
    subject:
      '{{firstName}}, your The Crafty Studio studio reservation has been cancelled',
    body: `Hello {{firstName}},

This notice confirms that your studio reservation has been cancelled.

Studio: {{studioName}}
Reservation ID: {{reservationId}}
Cancelled On: {{cancelledDate}}
Reason: {{reason}}

If this change was unexpected, please contact the studio team for assistance.

Best,
${BRANDING}`,
  },
  paymentReceipt: {
    subject: '{{firstName}}, your payment receipt from The Crafty Studio',
    body:
      `Hello {{firstName}},

This is your payment receipt from The Crafty Studio.

Receipt Number: {{receiptNumber}}
Amount: $` +
      '{{amount}}' +
      `
Payment Date: {{paymentDate}}
Description: {{description}}

Thank you for supporting The Crafty Studio.

Best,
${BRANDING}`,
  },
  transactionFailed: {
    subject:
      '{{firstName}}, your The Crafty Studio transaction could not be completed',
    body:
      `Hello {{firstName}},

We could not complete your transaction at The Crafty Studio.

Transaction ID: {{transactionId}}
Amount: $` +
      '{{amount}}' +
      `
Reason: {{reason}}

No access changes were applied from this failed transaction. Please try again or contact the studio team for help.

Best,
${BRANDING}`,
  },
  systemIssue: {
    subject: '{{firstName}}, a system update from The Crafty Studio',
    body: `Hello {{firstName}},

We want to let you know about a system issue affecting {{serviceName}} at The Crafty Studio.

Issue: {{issueSummary}}
Impact: {{impact}}
Update: {{resolution}}

We appreciate your patience and will continue to share updates as needed.

Best,
${BRANDING}`,
  },
  refundIssued: {
    subject: '{{firstName}}, your refund has been processed by The Crafty Studio',
    body:
      `Hello {{firstName}},

A refund has been issued for your The Crafty Studio account.

Refund ID: {{refundId}}
Amount: $` +
      '{{amount}}' +
      `
Reason: {{reason}}
Processed On: {{processedDate}}

Please allow a few business days for the funds to appear in your account.

Best,
${BRANDING}`,
  },
  dayPassIssued: {
    subject: '{{firstName}}, your The Crafty Studio day pass is active',
    body:
      `Hello {{firstName}},

A day pass has been issued for your The Crafty Studio account.

Pass ID: {{dayPassId}}
Valid Date: {{validDate}}
Amount: $` +
      '{{amount}}' +
      `

Please make sure required policies and waivers are signed before checking in.

Best,
${BRANDING}`,
  },
  membershipIssued: {
    subject: '{{firstName}}, your The Crafty Studio membership is active',
    body:
      `Hello {{firstName}},

A membership has been issued for your The Crafty Studio account.

Membership ID: {{membershipId}}
Plan: {{planName}}
Start Date: {{startDate}}
End Date: {{endDate}}
Amount: $` +
      '{{amount}}' +
      `

Thank you for being part of the studio community.

Best,
${BRANDING}`,
  },
};

export const ALL_NOTIFICATION_KEYS: NotificationKey[] = [
  'accountCreation',
  'accountCreationFailed',
  'waiverSigned',
  'reservationConfirmed',
  'reservationCancelled',
  'studioCancellation',
  'paymentReceipt',
  'transactionFailed',
  'systemIssue',
  'refundIssued',
  'dayPassIssued',
  'membershipIssued',
];

export function renderNotificationTemplate(
  key: NotificationKey,
  variables: NotificationVariables = {},
): NotificationTemplate {
  const template = notificationTemplates[key];
  if (!template) {
    throw new Error(`Unknown notification template: ${String(key)}`);
  }

  return {
    subject: interpolate(template.subject, variables),
    body: interpolate(template.body, variables),
  };
}
