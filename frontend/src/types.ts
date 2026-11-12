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
