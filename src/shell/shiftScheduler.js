'use strict';

import { posApi } from './posApi.js';
import { toaster } from './toast.js';
import { toMinutes, isWithinWindow, getBusinessDayStart } from './businessDay.js';

/**
 * There is no manual "Close Register" step anymore - the shift for a
 * business day is opened and closed entirely by this scheduler:
 *  - No shift open, and we're inside business hours -> open one.
 *  - A shift IS open, but it was opened before today's business-day
 *    boundary (i.e. it's a leftover from the previous day that never
 *    got closed because there's nothing left in the UI to close it) ->
 *    auto-close it (no cash count, so closing_cash/variance stay
 *    NULL - see shifts.autoCloseShift) and immediately open today's.
 * Outside business hours we don't touch anything; the leftover shift
 * simply keeps collecting any after-hours orders until the next
 * business day starts, same as before.
 */
async function tick() {
  try {
    const settings = await posApi.settings.getAll();
    if (settings.auto_day_start_enabled !== '1') return;

    const now = new Date();
    const dayStartTime = settings.day_start_time || '15:00';
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const startMin = toMinutes(dayStartTime);
    const endMin = toMinutes(settings.day_end_time || '03:00');
    const withinWindow = isWithinWindow(nowMin, startMin, endMin);

    if (!withinWindow) return;

    const shift = await posApi.shifts.getOpen();

    if (!shift) {
      const newShift = await posApi.shifts.open({ openedBy: 'Auto Schedule', openingFloat: 0 });
      toaster.success(`Day auto-started for business hours (shift #${newShift.id}).`);
      return;
    }

    const dayStart = getBusinessDayStart(now, dayStartTime);
    const shiftOpenedAt = new Date(String(shift.open_time).replace(' ', 'T') + 'Z');

    if (shiftOpenedAt < dayStart) {
      await posApi.shifts.autoClose(shift.id);
      const newShift = await posApi.shifts.open({ openedBy: 'Auto Schedule', openingFloat: 0 });
      toaster.success(`Previous day closed automatically. New day started (shift #${newShift.id}).`);
    }
  } catch (err) {
    console.error('[shiftScheduler] check failed', err);
  }
}

export function initShiftScheduler() {
  tick();
  setInterval(tick, 60 * 1000);
}
