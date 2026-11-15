// Presentation-level roles and fixture types; live API contracts are maintained under
// lib/*Contracts.ts and lib/contracts.ts.

export type UserRole = 'member' | 'staff' | 'admin';

export interface Equipment {
  id: number;
  name: string;
  type: string;
  rate: number;
  trainingRequired: boolean;
  image: string;
  availability: string;
}
