import type { Equipment, UserRole } from '../types';
export interface User {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
  roles: string[];
  membership: 'Monthly' | 'Day Pass' | 'Staff' | 'None';
  status: string;
  accessStatus: 'active' | 'suspended' | 'revoked';
}
export interface Session {
  user: User;
  csrfToken: string;
}
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
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
  equipmentId: number;
  equipmentName: string;
  startTime: string;
  endTime: string;
  location: string;
  status: string;
}
export interface Waiver {
  id: number;
  name: string;
  version: string;
  description: string;
  signed: boolean;
  signedAt: string | null;
}
export interface Certification {
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
