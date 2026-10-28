'use strict';

/**
 * Shared "business day" math. A restaurant's day doesn't reset at
 * midnight - it resets whenever Settings > Business Day says it does
 * (e.g. 3:00 AM). There is only a START time: a business day runs from
 * that time until the same time the next day (3 AM -> 3 AM), so there is
 * never a gap and never an overlap. Everything that groups or filters by
 * day uses these helpers - Order History, Hidden Records, Reports &
 * Analytics and Danger Zone - so they can never disagree about what
 * "today" means.
 */

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + m;
}

/**
 * Returns a Date for the start of the CURRENT business day, given the
 * "day starts at" time from Settings. If it's currently before that
 * time-of-day, the business day actually began yesterday (e.g. it's
 * 1:00 AM and the day starts at 3:00 PM - "today" started yesterday
 * at 3:00 PM).
 */
export function getBusinessDayStart(now, dayStartTime) {
  const startMin = toMinutes(dayStartTime || '00:00');
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = new Date(now);
  start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  if (nowMin < startMin) {
    start.setDate(start.getDate() - 1);
  }
  return start;
}

/** Formats a Date as a naive local "YYYY-MM-DD HH:MM:SS" string, matching how the rest of the app talks to the orders table. */
export function formatLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local calendar date of a Date as "YYYY-MM-DD" (NOT the UTC date toISOString() gives). */
export function toLocalDateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The business day an instant belongs to, as "YYYY-MM-DD" (the date the day STARTED on). */
export function businessDateKey(d, dayStartTime) {
  return toLocalDateKey(getBusinessDayStart(d, dayStartTime));
}

/**
 * Turns two date-picker values ("YYYY-MM-DD") into the exact business-day
 * range they cover: start date at the day-start time, through the moment
 * just before the day after the end date starts. With a 3 AM day start,
 * 10 Oct -> 12 Oct is 10 Oct 03:00:00 -> 13 Oct 02:59:59.
 */
export function businessRangeFromDates(startDateStr, endDateStr, dayStartTime) {
  const startMin = toMinutes(dayStartTime || '00:00');
  const at = (str, addDays) => {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d + addDays, Math.floor(startMin / 60), startMin % 60, 0, 0);
  };
  return { start: at(startDateStr, 0), end: new Date(at(endDateStr, 1).getTime() - 1000) };
}
