// Presentation-level roles and fixture types; live API contracts are maintained under
// lib/*Contracts.ts and lib/contracts.ts.

export type UserRole = 'member' | 'staff' | 'admin';

export interface WorkshopClass {
  id: number;
  title: string;
  description: string;
  instructor: string;
  equipment: string;
  date: string;
  time: string;
  enrolled: number;
  capacity: number;
  image: string;
  duration: string;
  price: number;
  status: 'available' | 'upcoming' | 'completed';
}

export interface Equipment {
  id: number;
  name: string;
  type: string;
  rate: number;
  trainingRequired: boolean;
  image: string;
  availability: string;
}
