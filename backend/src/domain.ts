export interface UserView {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: "member" | "staff" | "admin";
  roles: string[];
  primaryRole?: string;
  isStudent?: boolean;
  status: string;
  accessStatus: "active" | "suspended" | "revoked";
  membership: "Monthly" | "Day Pass" | "Staff" | "None";
}

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function positiveId(value: unknown, name = "id"): number {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      `${name} must be a positive integer.`,
    );
  }
  return n;
}

export function textField(
  value: unknown,
  name: string,
  max: number,
  min = 1,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      `${name} must contain ${min}–${max} characters.`,
    );
  }
  return value.trim();
}

export function emailField(value: unknown): string {
  const email = textField(value, "Email", 100).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AppError(400, "INVALID_INPUT", "Enter a valid email address.");
  return email;
}

export function dateOfBirthField(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Date of birth is required.",
    );
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Date of birth must use YYYY-MM-DD format.",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Enter a valid date of birth.",
    );
  }

  if (date > new Date()) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Date of birth cannot be in the future.",
    );
  }

  return value;
}

export function passwordField(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Password must contain 8–128 characters.",
    );
  }

  return value;
}

export function newPasswordField(value: unknown): string {
  const password = passwordField(value);

  if (password.length < 8) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Password must contain 8–128 characters.",
    );
  }

  if (!/[A-Z]/.test(password)) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Password must contain at least one uppercase letter.",
    );
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Password must contain at least one special character.",
    );
  }

  return password;
}

export function reservationWindow(
  start: unknown,
  end: unknown,
  now = new Date(),
): { start: Date; end: Date } {
  const parse = (v: unknown) => {
    const parts =
      typeof v === "string"
        ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
            v,
          )
        : null;
    if (!parts)
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Reservation times must be ISO dates with a time zone.",
      );
    const year = Number(parts[1]),
      month = Number(parts[2]),
      day = Number(parts[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day ||
      Number(parts[4]) > 23 ||
      Number(parts[5]) > 59 ||
      Number(parts[6] ?? 0) > 59
    ) {
      throw new AppError(400, "INVALID_INPUT", "Invalid reservation time.");
    }
    const d = new Date(v as string);
    if (!Number.isFinite(d.getTime()))
      throw new AppError(400, "INVALID_INPUT", "Invalid reservation time.");
    return d;
  };
  const a = parse(start);
  const b = parse(end);
  if (a <= now || b <= a || b.getTime() - a.getTime() > 24 * 60 * 60 * 1000) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Choose a future start and a duration of up to 24 hours.",
    );
  }
  return { start: a, end: b };
}
