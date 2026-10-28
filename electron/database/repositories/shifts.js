'use strict';

const { getDb } = require('../db');

/**
 * Opens a new shift. Throws if one is already open - the DB's
 * partial unique index (idx_shifts_single_open) is the real
 * enforcement, this is just a friendlier error message on top of it.
 */
function openShift({ openedBy = null, openingFloat = 0 } = {}) {
  const db = getDb();
  const existing = getOpenShift();
  if (existing) {
    throw new Error(`A shift (#${existing.id}) is already open. Close it before starting a new one.`);
  }

  const stmt = db.prepare(`
    INSERT INTO shifts (opened_by, opening_float, status)
    VALUES (@openedBy, @openingFloat, 'OPEN')
  `);
  const info = stmt.run({ openedBy, openingFloat });
  return getShiftById(info.lastInsertRowid);
}

function getOpenShift() {
  const db = getDb();
  return db.prepare(`SELECT * FROM shifts WHERE status = 'OPEN' LIMIT 1`).get() || null;
}

function getShiftById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id) || null;
}

/**
 * Sums completed order totals for a shift. Since the schema (per
 * client spec) doesn't split payment method per order, "expected
 * cash" here means expected total revenue for the shift. If/when a
 * payment_method column is added to orders, narrow this WHERE
 * clause to cash-only orders.
 */
function getShiftSalesTotal(shiftId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE shift_id = ? AND status = 'COMPLETED'`
    )
    .get(shiftId);
  return row.total;
}

/**
 * Manual "Close Day" action. Cashier/manager enters the physically
 * counted cash; system computes variance against expected revenue.
 */
function closeShift(shiftId, { closingCash }) {
  const db = getDb();
  const shift = getShiftById(shiftId);
  if (!shift) throw new Error(`Shift #${shiftId} not found.`);
  if (shift.status === 'CLOSED') throw new Error(`Shift #${shiftId} is already closed.`);

  const expectedCash = shift.opening_float + getShiftSalesTotal(shiftId);
  const variance = closingCash - expectedCash;

  db.prepare(
    `UPDATE shifts
     SET close_time = datetime('now'),
         closing_cash = @closingCash,
         expected_cash = @expectedCash,
         variance = @variance,
         status = 'CLOSED'
     WHERE id = @shiftId`
  ).run({ shiftId, closingCash, expectedCash, variance });

  return getShiftById(shiftId);
}

/**
 * Automatic "day rollover" close for a shift left open from a previous
 * day (there is no manual Close Register step, and nothing in the app
 * calls this on a timer anymore - day-based views follow the Business
 * Day setting, not shifts). No one physically counted the drawer, so
 * closing_cash/variance are left NULL instead of guessing a number - a
 * NULL variance reads as "not counted", which is honest, instead of a
 * fabricated "exact match".
 */
function autoCloseShift(shiftId) {
  const db = getDb();
  const shift = getShiftById(shiftId);
  if (!shift) throw new Error(`Shift #${shiftId} not found.`);
  if (shift.status === 'CLOSED') throw new Error(`Shift #${shiftId} is already closed.`);

  const expectedCash = shift.opening_float + getShiftSalesTotal(shiftId);

  db.prepare(
    `UPDATE shifts
     SET close_time = datetime('now'),
         closing_cash = NULL,
         expected_cash = @expectedCash,
         variance = NULL,
         status = 'CLOSED'
     WHERE id = @shiftId`
  ).run({ shiftId, expectedCash });

  return getShiftById(shiftId);
}

function listShifts({ limit = 30, offset = 0 } = {}) {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM shifts ORDER BY open_time DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

module.exports = {
  openShift,
  getOpenShift,
  getShiftById,
  getShiftSalesTotal,
  closeShift,
  autoCloseShift,
  listShifts,
};
