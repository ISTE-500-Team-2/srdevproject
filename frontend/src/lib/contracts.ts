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
  user: User;
  csrfToken: string;
  notification?: NotificationMessage;
}
export interface NotificationMessage {
  subject: string;
  body: string;
}
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  password: string;
}
export interface LiveEquipment extends Omit<Equipment, 'rate'> {
  rate: number | null;
  status: string;
  waiverRequired: boolean;
  certification: string | null;
  location: string;
  canReserve: boolean;
}
export interface Reservation {
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
export interface Waiver {
  id: number;
  versionId: number;
  name: string;
  version: string;
  description: string;
  signed: boolean;
  signedAt: string | null;
  signedVersion: string | null;
  signedVersionId: number | null;
  outdatedSignature: boolean;
  expiredSignature: boolean;
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
  entitlement: { membership: boolean; dayPass: boolean };
  pendingWaivers: number;
  activeReservations: number;
  canCheckIn: boolean;
  reasons: string[];
  recentCheckIns: { id: number; location: string; checkedInAt: string }[];
}
