import { registrationPrice, seatsLeft, type ClassRecord } from "./classData";

/**
 * Whether the member can register. A member under 18 also needs a linked sponsoring
 * adult with an active account ("no-sponsor" when none is linked, "sponsor-inactive"
 * when the linked adult cannot sponsor right now).
 */
export type Eligibility = "eligible" | "ineligible" | "no-sponsor" | "sponsor-inactive" | "sponsor-unknown" | "unknown";

const sponsorBlock = {
  "no-sponsor": {
    title: "Link a sponsor to sign up",
    body: "You’re under 18. A parent or guardian sends a sponsor request from their account; accept it on your Home page, then register here.",
    reason: "Link a sponsoring adult to sign up",
  },
  "sponsor-inactive": {
    title: "Your sponsor can’t sign you up",
    body: "You’re under 18, and your sponsoring adult’s account isn’t active right now. Ask them or staff at the front desk to sort it out, then register here.",
    reason: "Your sponsoring adult’s account isn’t active",
  },
  // Until the sponsor check answers, a minor can't be told they may register.
  "sponsor-unknown": {
    title: "Checking your sponsor",
    body: "You’re under 18, so your sponsoring adult is confirmed before you can register.",
    reason: "Checking your sponsoring adult",
  },
} as const;
export type SponsorBlock = (typeof sponsorBlock)[keyof typeof sponsorBlock];

/** Why a minor cannot register, or null when supervision is not what stands in the way. */
export const sponsorReason = (eligibility: Eligibility): SponsorBlock | null =>
  eligibility === "no-sponsor" || eligibility === "sponsor-inactive" || eligibility === "sponsor-unknown"
    ? sponsorBlock[eligibility]
    : null;

/**
 * The registration action a member is offered for a class that is open for registration
 * (not cancelled and not started; each view decides that itself). Checked in this order:
 * - `registered`: the member already holds a seat;
 * - `full`: no seat is left;
 * - `needs-pass`: the member needs an active membership or day pass first;
 * - `register`: a Register button, `disabled` while the request runs, while the training fee
 *   is not configured, or while a sponsor problem (`blocked`) stands in the way. `again` is
 *   true when the member withdrew earlier.
 * `blocked` is the sponsor problem for every unregistered member, so a view can explain it
 * even when the class is full.
 */
export type RegistrationAction =
  | { kind: "registered" }
  | { kind: "full"; blocked: SponsorBlock | null }
  | { kind: "needs-pass"; blocked: null }
  | { kind: "register"; blocked: SponsorBlock | null; again: boolean; disabled: boolean };

export function registrationAction({
  c,
  eligibility,
  certified,
  busy,
  seats = c,
}: {
  c: ClassRecord;
  eligibility: Eligibility;
  /** The member already holds the class's certification. */
  certified: boolean;
  /** A register or withdraw request for this class is running. */
  busy: boolean;
  /** The freshest seat counts the view has; the class record's own by default. */
  seats?: { capacity: number; enrolled: number };
}): RegistrationAction {
  if (c.myStatus === "enrolled") return { kind: "registered" };
  const blocked = sponsorReason(eligibility);
  if (seatsLeft(seats) === 0) return { kind: "full", blocked };
  // sponsorReason is null for "ineligible", so nothing is lost here.
  if (eligibility === "ineligible") return { kind: "needs-pass", blocked: null };
  return {
    kind: "register",
    blocked,
    again: c.myStatus === "cancelled",
    disabled: busy || registrationPrice(c, certified).trainingFee === null || !!blocked,
  };
}
