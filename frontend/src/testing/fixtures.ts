/**
 * Typed API response fixtures for page tests. Each builder returns a complete
 * response contract, so a test names only the fields it is about and the type
 * check fails when a contract gains a required field the fixture lacks.
 * Defaults are inert: they do not link records to each other or add display text.
 */
import type { Certification, LiveEquipment, Overview, Reservation, User } from '../lib/contracts';
import type { Person } from '../lib/staffContracts';

/** The signed-in account (useAuth().user). */
export const user = (fields: Partial<User> = {}): User => ({
  id: 1,
  firstName: 'Morgan',
  lastName: 'Member',
  email: 'member@example.com',
  phone: '0000000000',
  role: 'member',
  roles: ['member'],
  membership: 'None',
  ...fields,
});

/** A member account as staff read it (GET /admin/users/:id). */
export const staffPerson = (fields: Partial<Person> = {}): Person => ({
  id: 1,
  firstName: 'Jordan',
  lastName: 'Example',
  email: 'jordan@example.invalid',
  phone: '',
  status: 'active',
  accessStatus: 'active',
  accessReason: '',
  conductFlag: false,
  address: {},
  contactPreferences: {},
  roles: ['member'],
  revision: 1,
  ...fields,
});

/** A bookable machine from GET /equipment (a 3D printer unless overridden). */
export const liveEquipment = (fields: Partial<LiveEquipment> = {}): LiveEquipment => ({
  id: 4,
  name: '3D Printer',
  type: '3D printing',
  rate: 7,
  image: '/assets/3d-printer.webp',
  status: 'available',
  canReserve: true,
  trainingRequired: false,
  waiverRequired: false,
  certification: null,
  availability: 'Choose a time to check availability',
  location: 'Makerspace',
  ...fields,
});

/** A reservation (GET /reservations item or a reservation write's reply); no linked machine or location by default. */
export const reservation = (fields: Partial<Reservation> = {}): Reservation => ({
  id: 1,
  userId: 1,
  equipmentId: null,
  equipmentName: '3D Printer',
  location: '',
  startTime: '2030-01-01T14:00:00.000Z',
  endTime: '2030-01-01T15:00:00.000Z',
  status: 'confirmed',
  revision: 1,
  ...fields,
});

/** A certification the member holds (GET /me/certifications item). */
export const certification = (fields: Partial<Certification> = {}): Certification => ({
  id: 1,
  name: 'CNC Training',
  status: 'active',
  renewalDate: null,
  valid: true,
  ...fields,
});

/** GET /me/overview for a member with an active membership and nothing pending. */
export const overview = (fields: Partial<Overview> = {}): Overview => ({
  userId: 1,
  entitlement: { membership: true, dayPass: false },
  pendingWaivers: 0,
  activeReservations: 0,
  canCheckIn: true,
  checkInBuildingId: null,
  buildings: [],
  reasons: [],
  recentCheckIns: [],
  ...fields,
});
