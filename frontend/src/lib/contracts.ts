import type { Equipment, UserRole } from '../types';
export interface User {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
  roles: string[];
  primaryRole?: string;
  isStudent?: boolean;
  isMinor?: boolean;
  sponsorName?: string | null;
  membership: 'Monthly' | 'Day Pass' | 'Staff' | 'None';
}
export type ProfileFields = Record<string, string | boolean>;
export interface UserProfile {
  user: User;
  address: ProfileFields;
  contactPreferences: ProfileFields;
  studioContact: { name: string; email: string; phone: string | null };
}
export interface Session {
  accessToken?: string;
  expiresIn?: number;
  /** Whose account requests act on: an opened member account, or the signed-in person. */
  user: User;
  /** Set while a staff member has opened `user`'s account from the workspace. */
  actingAs?: { actor: User } | null;
  csrfToken: string;
  notification?: NotificationMessage;
}
export interface NotificationMessage {
  subject: string;
  body: string;
}
// Public sign-up collects email only; a member identity is allocated after inbox confirmation.
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  password: string;
}
export interface LiveEquipment extends Omit<Equipment, 'rate'> {
  trainingFeeCents?: number | null;
  trainingMinutes?: number | null;
  occupied?: {startTime: string; endTime: string}[];
  rate: number | null;
  status: string;
  outages?: { reason: string; expectedBack: string | null; startedAt: string; endedAt: string | null }[];
  waiverRequired: boolean;
  /** The required certification's id; null when the equipment needs none. */
  certId?: number | null;
  certification: string | null;
  location: string;
  canReserve: boolean;
}
export interface Reservation {
  amountCents?: number | null;
  payerId?: number | null;
  holdUntil?: string | null;
  checkoutUrl?: string;
  priceSnapshot?: EquipmentPrice | null;
  paymentId?: number | null;
  paymentStatus?: string | null;
  id: number;
  userId: number;
  equipmentId: number | null;
  roomId?: number | null;
  equipmentName: string;
  resourceType?: 'equipment' | 'room';
  startTime: string;
  endTime: string;
  location: string;
  status: string;
  revision: number;
  memberName?: string;
  memberEmail?: string;
}
export interface EquipmentPrice {
  currency: 'USD'; hours: number; hourlyRateCents: number; equipmentCents: number;
  trainingFeeCents: number; totalCents: number; certificationId: number | null;
  certificationRevision: number | null;
}
export interface Waiver {
  id: number;
  versionId: number;
  name: string;
  version: string;
  description: string;
  scope: 'facility' | 'equipment';
  formFields?: WaiverFormField[];
  /** The account holder's name; a form signature has to match it. */
  signerName?: string;
  signed: boolean;
  signedAt: string | null;
  signedVersion: string | null;
  signedVersionId: number | null;
  outdatedSignature: boolean;
  expiredSignature: boolean;
  /** When the current signature runs out, or when the last one of this version did; null if it never expires. */
  expiresAt?: string | null;
}
export interface WaiverFormField {
  key: string;
  label: string;
  line: number;
  type: 'text' | 'date' | 'datetime-local' | 'email' | 'tel';
  section: 'participant' | 'guardian' | 'administrative';
  /** 'server' fields (identity, version, signing time) are filled in when the waiver is signed. */
  source: 'member' | 'server';
  required: boolean;
  maxLength: number;
}
export interface Certification {
  trainedAt?: string|null;
  approvedAt?: string|null;
  instructorName?: string|null;
  equipmentIds?: number[];
  validityDays?: number|null;
  revision?: number;
  id: number;
  name: string;
  status: string;
  renewalDate: string | null;
  valid: boolean;
}
export interface Overview {
  userId: number;
  entitlement: { membership: boolean; dayPass: boolean };
  pendingWaivers: number;
  activeReservations: number;
  canCheckIn: boolean;
  checkInBuildingId: number | null;
  buildings: { id: number; name: string; status: string }[];
  reasons: string[];
  recentCheckIns: { id: number; location: string; checkedInAt: string; method?: 'nfc' | 'portal' }[];
}
/** An open facility visit. Staff reads may omit the building name. */
export interface FacilityVisit {
  id: number;
  buildingId: number;
  buildingName?: string;
  checkedInAt: string;
  sponsorId: number | null;
}
/** GET /me/supervision and GET /admin/users/:id/supervision. */
export interface SupervisionSummary {
  isMinor: boolean;
  marker: 'Under 18' | null;
  sponsor: { id: number; name: string; revision: number; email?: string } | null;
  /** True when the linked sponsor is an active adult, so the minor can register for classes. */
  sponsorEligible: boolean;
  visit: FacilityVisit | null;
  /** Adults asking this minor to accept them as sponsor (own summary only). */
  pendingRequests?: SponsorRequest[];
}
export interface SponsorRequest {
  id: number;
  adultName: string;
  createdAt: string;
}
/** GET /me/minors: minors this adult sponsors and requests awaiting their answer. */
export interface SupervisedMinors {
  minors: { id: number; name: string; visit: { buildingName: string; checkedInAt: string } | null }[];
  requests: MinorLinkRequest[];
}
export interface MinorLinkRequest {
  id: number;
  minorName: string;
  createdAt: string;
}
