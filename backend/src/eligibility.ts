/**
 * Member eligibility decisions shared by the previews (the equipment catalogue and
 * the member overview) and AccessService enforcement. Each decision reports the
 * same reason code AccessService throws as its AppError code; every surface keeps
 * its own wording for that code.
 */
export type EligibilityCode =
  | 'INSTRUCTOR_BOOKING_FORBIDDEN'
  | 'ACCESS_BLOCKED'
  | 'RESOURCE_UNAVAILABLE'
  | 'MEMBERSHIP_REQUIRED'
  | 'CERTIFICATION_REQUIRED'
  | 'WAIVERS_NOT_CONFIGURED'
  | 'WAIVER_REQUIRED';

type Entitlement = { membership: boolean; dayPass: boolean };
type Signable = readonly { signed: boolean }[];

export const accessStatusCode = (accessStatus: string) =>
  accessStatus !== 'active' ? 'ACCESS_BLOCKED' as const : null;

export const entitlementCode = (entitlement: Entitlement) =>
  !entitlement.membership && !entitlement.dayPass ? 'MEMBERSHIP_REQUIRED' as const : null;

/** Unconfigured policies are reported before unsigned ones. */
export const waiverCode = (waivers: Signable) =>
  !waivers.length ? 'WAIVERS_NOT_CONFIGURED' as const
    : waivers.some(w => !w.signed) ? 'WAIVER_REQUIRED' as const : null;

/** Equipment waivers follow the facility policies, as in AccessService.assertEquipmentWaivers. */
export const equipmentWaiverCode = (facility: Signable, equipment: Signable) =>
  waiverCode(facility) ?? waiverCode(equipment);

const present = <T>(codes: (T | null)[]) => codes.filter((code): code is T => code !== null);

/** Every reason this member cannot reserve the item, in the order members read them. */
export function equipmentEligibility(input: {
  instructor: boolean;
  accessStatus: string;
  available: boolean;
  entitlement: Entitlement;
  /** True when the item needs no certification or the member holds a current one. */
  certified: boolean;
  waiverRequired: boolean;
  facilityWaivers: Signable;
  equipmentWaivers: Signable;
}): EligibilityCode[] {
  return present<EligibilityCode>([
    input.instructor ? 'INSTRUCTOR_BOOKING_FORBIDDEN' : null,
    accessStatusCode(input.accessStatus),
    input.available ? null : 'RESOURCE_UNAVAILABLE',
    entitlementCode(input.entitlement),
    input.certified ? null : 'CERTIFICATION_REQUIRED',
    input.waiverRequired ? equipmentWaiverCode(input.facilityWaivers, input.equipmentWaivers) : null,
  ]);
}

export type MemberAccessCode = 'ACCESS_BLOCKED' | 'MEMBERSHIP_REQUIRED' | 'WAIVERS_NOT_CONFIGURED' | 'WAIVER_REQUIRED';

/** Why the member cannot check in at all, before any building-specific check. */
export function memberAccessEligibility(input: {
  accessStatus: string;
  entitlement: Entitlement;
  facilityWaivers: Signable;
}): MemberAccessCode[] {
  return present<MemberAccessCode>([
    accessStatusCode(input.accessStatus),
    entitlementCode(input.entitlement),
    waiverCode(input.facilityWaivers),
  ]);
}

const EQUIPMENT_TEXT: Record<EligibilityCode, string> = {
  INSTRUCTOR_BOOKING_FORBIDDEN: 'Instructor accounts cannot create reservations',
  ACCESS_BLOCKED: 'Facility access is suspended or revoked',
  RESOURCE_UNAVAILABLE: 'Equipment unavailable',
  MEMBERSHIP_REQUIRED: 'Membership or day pass required',
  CERTIFICATION_REQUIRED: 'Current certification required',
  WAIVERS_NOT_CONFIGURED: 'Signed waivers required',
  WAIVER_REQUIRED: 'Signed waivers required',
};
const OUTAGE_TEXT: Record<string, string> = {
  repair: 'Out of service for repair',
  maintenance: 'Out of service for maintenance',
  safety: 'Out of service for a safety check',
  other: 'Temporarily out of service',
};

/** Catalogue wording. An open outage explains why the item is unavailable. */
export function equipmentReasonText(code: EligibilityCode, openOutage?: { reason: string }) {
  return code === 'RESOURCE_UNAVAILABLE' && openOutage ? OUTAGE_TEXT[openOutage.reason]! : EQUIPMENT_TEXT[code];
}

const MEMBER_ACCESS_TEXT: Record<MemberAccessCode, string> = {
  ACCESS_BLOCKED: 'Facility access is suspended or revoked; contact staff',
  MEMBERSHIP_REQUIRED: 'Active membership or day pass required',
  WAIVERS_NOT_CONFIGURED: 'Required policies have not been configured',
  WAIVER_REQUIRED: 'Required policies and waivers need your signature',
};

/** Member overview wording. */
export const memberAccessReasonText = (code: MemberAccessCode) => MEMBER_ACCESS_TEXT[code];
