/** A certification in the training catalog, as /training/catalog returns it. */
export type Course = {
  id: number;
  name: string;
  description: string;
  validityDays: number | null;
  revision: number;
  equipmentIds: number[];
  trainingFeeCents: number | null;
  trainingMinutes: number;
  endsAt?: string | null;
};

/** A member's training record for one certification, as /training/users/:id returns it. */
export type TrainingRecord = {
  id: number;
  certificationId: number;
  name: string;
  status: string;
  valid: boolean;
  revision: number;
  expiresAt: string | null;
  trainedAt: string | null;
  revokedAt?: string | null;
  instructorName: string | null;
  trainingMinutes?: number | null;
};

/**
 * How many active members hold a certification, as /training/catalog/holders returns it.
 * `expiringSoon` is the part of `current` that runs out within 30 days; `expired` counts
 * training that is no longer current for any reason other than a revocation.
 */
export type CertificationHolders = {
  id: number;
  current: number;
  expiringSoon: number;
  expired: number;
  revoked: number;
};

/** The certification editor: a new certification has no saved record to start from. */
export type CourseEditor = { mode: "new" } | { mode: "edit"; course: Course };

/**
 * The certification a member's training is being recorded for. A first training has no
 * record yet, so only the certification is known.
 */
export type TrainingTarget = Pick<TrainingRecord, "certificationId" | "name">;

/** A read the workflows show while it loads or fails. */
export type Loaded<T> = { data: T | null; loading: boolean; error: string; reload: () => void };

/** What the page does around every training change: clear the old notice, then refresh and confirm. */
export type SaveOutcome = { started: () => void; saved: () => void };
