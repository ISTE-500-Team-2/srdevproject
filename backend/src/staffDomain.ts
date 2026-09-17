import { AppError, positiveId, textField } from "./domain.js";

export function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new AppError(
      400,
      "INVALID_INPUT",
      `${name} must be ${choices.join(", ")}.`,
    );
  return value as T;
}
export function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new AppError(400, "INVALID_INPUT", `${name} must be true or false.`);
  return value;
}
export function money(value: unknown): string {
  // Decimal strings only: no binary floating-point rounding of money.
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value)
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Price must be a nonnegative decimal string with at most two decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
export function calendarDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^20\d{2}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Use a valid calendar date (YYYY-MM-DD), between 2000 and 2099.",
    );
  return value;
}
export function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Use an ISO date and time with a timezone.",
    );
  calendarDate(value.slice(0, 10));
  if (
    +value.slice(11, 13) > 23 ||
    +value.slice(14, 16) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new AppError(400, "INVALID_INPUT", "Invalid date or time.");
  return new Date(value).toISOString();
}
export function reasonField(value: unknown) {
  return textField(value, "Reason", 255, 3);
}
export function revisionField(value: unknown) {
  return positiveId(value, "revision");
}
export function pageOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "string" ||
    !/^\d{1,7}$/.test(value) ||
    Number(value) > 1000000
  )
    throw new AppError(400, "INVALID_INPUT", "Invalid page offset.");
  return Number(value);
}
export interface PlanInput {
  name: string;
  kind: "membership" | "day_pass";
  price: string;
  months: number | null;
  benefits: string;
  active: boolean;
}
export function planInput(body: Record<string, unknown>): PlanInput {
  const kind = oneOf(
    body.kind,
    ["membership", "day_pass"] as const,
    "Plan kind",
  );
  const months =
    kind === "membership" ? positiveId(body.months, "Months") : null;
  if (months !== null && months > 120)
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Memberships may cover up to 120 calendar months.",
    );
  return {
    name: textField(body.name, "Plan name", 50),
    kind,
    price: money(body.price),
    months,
    benefits: textField(body.benefits, "Benefits", 4000, 0),
    active: booleanField(body.active, "Active"),
  };
}
export interface IssueInput {
  requestId: string;
  planId: number;
  startsAt: string | null;
  validDate: string | null;
  paymentStatus: "pending" | "paid" | "waived";
  method: string;
  reference: string;
  reason: string;
}
export function issueInput(body: Record<string, unknown>): IssueInput {
  if (
    typeof body.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.requestId,
    )
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "A version-4 request ID is required for safe retries.",
    );
  const paymentStatus = oneOf(
    body.paymentStatus,
    ["pending", "paid", "waived"] as const,
    "Payment record",
  );
  const method = paymentMethod(body.method);
  validatePaymentMethod(paymentStatus, method);
  return {
    requestId: body.requestId.toLowerCase(),
    planId: positiveId(body.planId, "Plan"),
    startsAt: body.startsAt == null ? null : instant(body.startsAt),
    validDate: body.validDate == null ? null : calendarDate(body.validDate),
    paymentStatus,
    method,
    reference: textField(body.reference ?? "", "External reference", 100, 0),
    reason: reasonField(body.reason),
  };
}
export function paymentMethod(value: unknown) {
  return oneOf(
    value,
    ["unspecified", "cash", "external_card", "bank_transfer", "other"] as const,
    "Payment method",
  );
}
export function validatePaymentMethod(status: string, method: string) {
  if (status === "paid" && method === "unspecified")
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Record the method used for the externally received payment.",
    );
}
