export function reservationInput(
  equipmentId: number,
  localStart: string,
  hours: number,
  now = Date.now(),
) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStart) ||
    ![1, 2, 3, 5].includes(hours)
  )
    throw new RangeError('Choose a start time and duration.');
  const start = new Date(localStart);
  const [date, time] = localStart.split('T');
  const [year, month, day] = date!.split('-').map(Number);
  const [hour, minute] = time!.split(':').map(Number);
  if (
    !Number.isFinite(start.getTime()) ||
    start.getFullYear() !== year ||
    start.getMonth() + 1 !== month ||
    start.getDate() !== day ||
    start.getHours() !== hour ||
    start.getMinutes() !== minute
  )
    throw new RangeError('Choose a valid local date and time.');
  if (start.getTime() <= now)
    throw new RangeError('Choose a start time in the future.');
  return {
    equipmentId,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  };
}
