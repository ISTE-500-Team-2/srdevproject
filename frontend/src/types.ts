export type UserRole = 'member' | 'admin';

export interface DemoUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  membership: 'Monthly' | 'Day Pass' | 'Staff';
}

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

export interface StudioSpace {
  id: number;
  name: string;
  size: 'Small' | 'Medium' | 'Large';
  description: string;
  monthlyRate: number;
  image: string;
  availability: string;
}

export interface CredentialRecord {
  id: number;
  name: string;
  status: 'Complete' | 'Incomplete' | 'Signed' | 'Unsigned';
  date: string | null;
}
