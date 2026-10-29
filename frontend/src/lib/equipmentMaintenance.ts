import type { Reservation } from './contracts';
export const maintenanceReasons: Record<string, string> = {
  repair: 'Repair', maintenance: 'Routine maintenance', safety: 'Safety concern', other: 'Other',
};
export interface Outage {
  id: number; reason: string; staffNote: string; expectedBack: string | null;
  startedAt: string; startedBy: string; endedAt: string | null; endedBy: string | null; returnNote: string | null;
}
export interface ManagedEquipment {
  id: number; name: string; type: string; rate: number | null; image: string; status: string;
  location: string; certification: string | null; availabilityRevision: number; outage: Outage | null;
  activeReaderLeases?: number;
}
export interface EquipmentDetail extends ManagedEquipment {
  history: Outage[]; checkedAt: string; timeZone: string; canManage: boolean; canReadBookings: boolean; canManageBookings: boolean;
  activeGrants: { readerId: string; expiresAt: string; members: string[] }[];
}
export interface EquipmentBooking extends Reservation { isClass: boolean }
export interface MoveReview {
  reservationId: number; expectedRevision: number; equipmentId: number; equipmentName: string;
  startTime: string; endTime: string; oldRate: number | null; rate: number | null;
}
export function equipmentTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
export function equipmentRate(value: number | null) { return value === null ? 'Rate not set' : `$${value.toFixed(2)}/hr`; }
