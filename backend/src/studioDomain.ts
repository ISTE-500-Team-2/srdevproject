import { AppError } from './domain.js';

export interface StudioLeaseWindow {
    startDate: string;
    endDate: string;
    months: number;
}

export function localStudioDate(now: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function parsedDate(value: unknown): { text: string; year: number; month: number; day: number } {
    const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!match)
        throw new AppError(400, 'INVALID_INPUT', 'Choose a valid studio start date.');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
    )
        throw new AppError(400, 'INVALID_INPUT', 'Choose a valid studio start date.');
    return { text: value as string, year, month, day };
}

export function studioLeaseWindow(
    startValue: unknown,
    monthsValue: unknown,
    timeZone: string,
    now = new Date(),
): StudioLeaseWindow {
    const start = parsedDate(startValue);
    const months =
        typeof monthsValue === 'string' && /^\d+$/.test(monthsValue)
            ? Number(monthsValue)
            : monthsValue;
    if (typeof months !== 'number' || !Number.isSafeInteger(months) || months < 1)
        throw new AppError(400, 'INVALID_INPUT', 'Lease term must be a positive whole number of months.');
    if (start.text <= localStudioDate(now, timeZone))
        throw new AppError(400, 'INVALID_INPUT', 'Studio leases must start on a future date.');

    const monthIndex = start.year * 12 + (start.month - 1) + months;
    const endYear = Math.floor(monthIndex / 12);
    const endMonth = (monthIndex % 12) + 1;
    const finalDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
    const endDay = Math.min(start.day, finalDay);
    const endDate = `${String(endYear).padStart(4, '0')}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endYear > 9999)
        throw new AppError(400, 'INVALID_INPUT', 'Lease term is outside the supported date range.');
    return { startDate: start.text, endDate, months };
}
