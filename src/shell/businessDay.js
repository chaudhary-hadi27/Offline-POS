'use strict';

/**
 * Shared "business day" math. A restaurant's day doesn't reset at
 * midnight - it resets whenever Settings > Scheduled Business Hours
 * says it does (e.g. 3:00 PM). This is used both by the auto shift
 * scheduler (src/shell/shiftScheduler.js) and by Order History's
 * "Today" filter, so the two never disagree about what "today" means.
 */

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + m;
}

/** Handles the overnight-wrap case (e.g. 15:00 -> 03:00 spans midnight). */
export function isWithinWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
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
