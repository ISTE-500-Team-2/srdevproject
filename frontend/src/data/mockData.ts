import type {
  CredentialRecord,
  DemoUser,
  Equipment,
  StudioSpace,
  WorkshopClass,
} from '../types';

export const demoUsers: Record<'member' | 'admin', DemoUser> = {
  member: {
    id: 101,
    firstName: 'John',
    lastName: 'Maker',
    email: 'member@collaboratory.demo',
    role: 'member',
    membership: 'Monthly',
  },
  admin: {
    id: 1,
    firstName: 'Alex',
    lastName: 'Admin',
    email: 'admin@collaboratory.demo',
    role: 'admin',
    membership: 'Staff',
  },
};

export const classes: WorkshopClass[] = [
  {
    id: 1,
    title: 'Laser Engraving',
    description: 'Use a laser engraver to make a custom cutting board.',
    instructor: 'Evan Willard',
    equipment: 'Laser Engraver',
    date: 'April 17',
    time: '11:00 AM–1:00 PM',
    enrolled: 10,
    capacity: 12,
    image: '/assets/laser-class.webp',
    duration: '2 hour session',
    price: 24,
    status: 'upcoming',
  },
  {
    id: 2,
    title: '3D Printed Robots',
    description: 'Use a 3D printer to create your own little robot friend.',
    instructor: 'Nora Callon',
    equipment: '3D Printer',
    date: 'April 29',
    time: '1:00 PM–4:00 PM',
    enrolled: 8,
    capacity: 14,
    image: '/assets/printing-class.webp',
    duration: '3 hour session',
    price: 18,
    status: 'upcoming',
  },
  {
    id: 3,
    title: 'Metal Rings',
    description: 'Turn and finish a simple metal ring with guided instruction.',
    instructor: 'Evan Willard',
    equipment: 'Metal Lathe',
    date: 'May 24',
    time: '12:00 PM–2:00 PM',
    enrolled: 2,
    capacity: 12,
    image: '/assets/wood-lathe.webp',
    duration: '2 hour session',
    price: 20,
    status: 'available',
  },
];

export const equipment: Equipment[] = [
  {
    id: 1,
    name: 'Rachel',
    type: '3D Printer',
    rate: 7,
    trainingRequired: false,
    image: '/assets/3d-printer.webp',
    availability: 'Today after 2:00 PM',
  },
  {
    id: 2,
    name: 'Darth Vader',
    type: 'Laser Engraver',
    rate: 20,
    trainingRequired: false,
    image: '/assets/laser-engraver.webp',
    availability: 'Tomorrow at 10:00 AM',
  },
  {
    id: 3,
    name: 'Spock',
    type: 'Wood Lathe',
    rate: 12,
    trainingRequired: true,
    image: '/assets/wood-lathe.webp',
    availability: 'Friday at 1:00 PM',
  },
  {
    id: 4,
    name: 'Chandler',
    type: 'Small CNC',
    rate: 28,
    trainingRequired: true,
    image: '/assets/cnc-machine.webp',
    availability: 'Monday at 9:00 AM',
  },
];

export const studioSpaces: StudioSpace[] = [
  {
    id: 1,
    name: 'Paris',
    size: 'Large',
    description: 'A large maker studio for ambitious builds and small teams.',
    monthlyRate: 1200,
    image: '/assets/space-paris.webp',
    availability: 'Available October 1',
  },
  {
    id: 2,
    name: 'Coruscant',
    size: 'Medium',
    description: 'A focused studio with bench space and abundant natural light.',
    monthlyRate: 750,
    image: '/assets/space-coruscant.webp',
    availability: 'Available now',
  },
  {
    id: 3,
    name: 'Harkonnen',
    size: 'Small',
    description: 'A compact private studio for precise, independent work.',
    monthlyRate: 350,
    image: '/assets/space-harkonnen.webp',
    availability: 'Available September 15',
  },
];

export const certifications: CredentialRecord[] = [
  { id: 1, name: 'CNC Machine', status: 'Complete', date: '01/09/2026' },
  { id: 2, name: 'Wood Lathe', status: 'Incomplete', date: null },
  { id: 3, name: 'Metal Lathe', status: 'Incomplete', date: null },
];

export const waivers: CredentialRecord[] = [
  { id: 1, name: 'Liability Agreement', status: 'Signed', date: '12/21/2025' },
  { id: 2, name: 'Code of Conduct', status: 'Signed', date: '12/21/2025' },
  { id: 3, name: 'IP Agreement', status: 'Signed', date: '12/21/2025' },
];

export const revenueSeries = [0, 980, 1450, 2780, 2460, 3820];
export const machineRevenueSeries = [0, 640, 690, 1520, 1810, 2380];
export const usageSeries = [6.4, 10.6, 8.3, 11.5, 13.9];
