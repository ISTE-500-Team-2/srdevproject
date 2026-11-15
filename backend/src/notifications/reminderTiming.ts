/** The single expiration-reminder timing policy, used both when a reminder is
 * first queued and when a member's time zone change reschedules it. */
const DAY=86_400_000;
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}
function dateParts(date:Date,timeZone:string) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(name:string)=>Number(parts.find(p=>p.type===name)!.value);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute'),second:get('second')};
}
/** Send at 09:00 eight local calendar days before expiry, leaving retry headroom
 * before the strict seven-elapsed-day deadline. Handles DST without fixed offsets. */
export function reminderDates(expiry:Date,timeZone:string):{dueAt:Date;deadlineAt:Date} {
  if (!Number.isFinite(expiry.getTime()) || !validTimeZone(timeZone)) throw new Error('Invalid expiry/time zone');
  const p=dateParts(expiry,timeZone);
  const target=new Date(Date.UTC(p.year,p.month-1,p.day-8,9));
  const desired=target.getTime();
  let actual=desired;
  for(let i=0;i<5;i++) {
    const local=dateParts(new Date(actual),timeZone);
    const represented=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute,local.second);
    const correction=desired-represented;
    actual+=correction;
    if(correction===0)break;
  }
  const deadlineAt=new Date(expiry.getTime()-7*DAY);
  return {dueAt:new Date(Math.min(actual,deadlineAt.getTime()-3_600_000)),deadlineAt};
}
