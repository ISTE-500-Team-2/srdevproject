export type NotificationKey =
  | 'accountCreation'
  | 'waiverSigned'
  | 'reservationConfirmed'
  | 'reservationCancelled'
  | 'paymentReceipt'
  | 'systemIssue'
  | 'refundIssued';

export type NotificationVariables = Record<string, string | number | undefined>;

export interface NotificationTemplate {
  subject: string;
  body: string;
}

const BRANDING = `The Crafty Studio\n123 Maker Lane\nhello@thecraftystudio.com`;

const interpolate = (template: string, variables: NotificationVariables) =>
  template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => {
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });

export const notificationTemplates: Record<NotificationKey, NotificationTemplate> = {
  accountCreation: {
    subject: '{{firstName}}, welcome to The Crafty Studio — your account is ready',
    body: `Hello {{firstName}},\n\nWelcome to The Crafty Studio! Your studio account has been created successfully.\n\nYour account email: {{email}}\n\nWe’re excited to help you reserve equipment, sign waivers, and make the most of your studio time.\n\nBest,\n${BRANDING}`,
  },
  waiverSigned: {
    subject: '{{firstName}}, your signed waiver is on file at The Crafty Studio',
    body: `Hello {{firstName}},\n\nThis message confirms that your signed waiver, {{waiverName}}, has been received and stored by The Crafty Studio.\n\nYour signed waiver was recorded on {{signatureDate}}. A copy of the signed waiver has been attached to this notification for your records.\n\nThank you for keeping your account current and safe.\n\nBest,\n${BRANDING}`,
  },
  reservationConfirmed: {
    subject: '{{firstName}}, your reservation is confirmed at The Crafty Studio',
    body: `Hello {{firstName}},\n\nYour reservation has been confirmed at The Crafty Studio.\n\nReservation ID: {{reservationId}}\nEquipment: {{equipmentName}}\nStatus: Confirmed\n\nWe look forward to seeing you soon.\n\nBest,\n${BRANDING}`,
  },
  reservationCancelled: {
    subject: '{{firstName}}, your The Crafty Studio reservation has been cancelled',
    body: `Hello {{firstName}},\n\nThis notice confirms that your reservation for {{equipmentName}} at The Crafty Studio has been cancelled.\n\nReservation ID: {{reservationId}}\nStatus: Cancelled\n\nIf this change was unexpected, please contact the studio team for assistance.\n\nBest,\n${BRANDING}`,
  },
  paymentReceipt: {
    subject: '{{firstName}}, your payment receipt from The Crafty Studio',
    body: `Hello {{firstName}},\n\nThis is your payment receipt from The Crafty Studio.\n\nReceipt Number: {{receiptNumber}}\nAmount: $` + '{{amount}}' + `\nPayment Date: {{paymentDate}}\nDescription: {{description}}\n\nThank you for supporting The Crafty Studio.\n\nBest,\n${BRANDING}`,
  },
  systemIssue: {
    subject: '{{firstName}}, a system update from The Crafty Studio',
    body: `Hello {{firstName}},\n\nWe want to let you know about a system issue affecting {{serviceName}} at The Crafty Studio.\n\nIssue: {{issueSummary}}\nImpact: {{impact}}\nUpdate: {{resolution}}\n\nWe appreciate your patience and will continue to share updates as needed.\n\nBest,\n${BRANDING}`,
  },
  refundIssued: {
    subject: '{{firstName}}, your refund has been processed by The Crafty Studio',
    body: `Hello {{firstName}},\n\nA refund has been issued for your The Crafty Studio account.\n\nRefund ID: {{refundId}}\nAmount: $` + '{{amount}}' + `\nReason: {{reason}}\nProcessed On: {{processedDate}}\n\nPlease allow a few business days for the funds to appear in your account.\n\nBest,\n${BRANDING}`,
  },
};

export const ALL_NOTIFICATION_KEYS: NotificationKey[] = [
  'accountCreation',
  'waiverSigned',
  'reservationConfirmed',
  'reservationCancelled',
  'paymentReceipt',
  'systemIssue',
  'refundIssued',
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
