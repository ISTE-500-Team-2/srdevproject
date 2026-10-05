import type { WorkshopClass } from '../types';

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

export const revenueSeries = [0, 980, 1450, 2780, 2460, 3820];
export const machineRevenueSeries = [0, 640, 690, 1520, 1810, 2380];
export const usageSeries = [6.4, 10.6, 8.3, 11.5, 13.9];
