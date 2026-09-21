import { AppError } from "../domain.js";
export function monthlyWindow(
  value: unknown,
  today = new Date().toISOString().slice(0, 10),
) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new AppError(400, "INVALID_DATE", "Choose a valid start date.");
  const start = new Date(value + "T00:00:00Z");
  if (
    !Number.isFinite(start.getTime()) ||
    start.toISOString().slice(0, 10) !== value ||
    value < today ||
    value > "2100-01-01"
  )
    throw new AppError(
      400,
      "INVALID_DATE",
      "Choose today or a future date before 2100.",
    );
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  end.setUTCDate(
    Math.min(
      start.getUTCDate(),
      new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    ),
  );
  return { start: value, end: end.toISOString().slice(0, 10) };
}
export function refundDue(
  rental: {
    starts_on: string;
    amount_cents: number;
    cancellation_policy: string;
  },
  today: string,
) {
  return rental.cancellation_policy === "full_before_start" &&
    today < rental.starts_on
    ? rental.amount_cents
    : 0;
}
export function integer(value: unknown, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      `Enter a whole number from ${min} to ${max}.`,
    );
  return value;
}
