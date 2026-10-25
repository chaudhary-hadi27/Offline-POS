'use strict';

const { getDb } = require('../db');
const { getOpenShift, openShift } = require('./shifts');

/**
 * Creates an order + its line items atomically. If anything throws
 * inside the transaction, better-sqlite3 rolls the whole thing back -
 * we never want a half-written order (e.g. header saved but line
 * items missing) sitting in the database.
 *
 * @param {object} payload
 * @param {Array<{itemId:number, name:string, nameUrdu?:string, quantity:number, unitPrice:number}>} payload.lines
 */
function createOrder(payload) {
  const db = getDb();
  // Validate BEFORE touching anything else. Previously the shift
  // auto-open below ran first, so a rejected empty order still left a
  // stray "Auto (Order)" shift (with opening_float 0) permanently in
  // the shifts table - corrupting the real Close-Register variance
  // math for the rest of the day even though the order itself never
  // got created. Order validation must always be a pure check with
  // zero DB side effects on failure.
  if (!payload.lines || payload.lines.length === 0) {
    throw new Error('Cannot submit an empty order.');
  }

  const subtotal = payload.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const taxRate = payload.taxRate ?? 0;
  const taxAmount = +(subtotal * (taxRate / 100)).toFixed(2);
  // Delivery charge is a flat fee (Settings > Restaurant & Receipt),
  // separate from tax - it rides on top of subtotal+tax rather than
  // being taxed itself. Non-delivery orders always pass 0/omit it.
  const deliveryCharge = +(payload.deliveryCharge || 0).toFixed(2);
  const total = +(subtotal + taxAmount + deliveryCharge).toFixed(2);

  const insertOrder = db.prepare(`
    INSERT INTO orders
      (shift_id, customer_id, customer_name, customer_phone, customer_address,
       order_type, subtotal, tax_rate, tax_amount, delivery_charge, total, status)
    VALUES
      (@shiftId, @customerId, @customerName, @customerPhone, @customerAddress,
       @orderType, @subtotal, @taxRate, @taxAmount, @deliveryCharge, @total, 'COMPLETED')
  `);

  const insertLine = db.prepare(`
    INSERT INTO order_items (order_id, item_id, item_name_snapshot, item_name_urdu_snapshot, quantity, unit_price, total_price)
    VALUES (@orderId, @itemId, @itemName, @itemNameUrdu, @quantity, @unitPrice, @totalPrice)
  `);

  const runTransaction = db.transaction(() => {
    // Orders no longer require someone to have pressed "Start Day"
    // first (see src/modules/newOrder.js - the "No shift is open"
    // screen was removed). orders.shift_id is still NOT NULL in the
    // schema, so if nothing is open we quietly open one here instead
    // of blocking the cashier. This now runs INSIDE the same
    // transaction as the order insert: if anything below fails (e.g.
    // a bad item_id violating the FK), the auto-opened shift rolls
    // back with it instead of being left stranded open with no order
    // in it. Settings > Scheduled Business Hours still governs what
    // counts as "Today" in Order History, independent of this.
    const shift = getOpenShift() || openShift({ openedBy: 'Auto (Order)', openingFloat: 0 });

    const orderInfo = insertOrder.run({
      shiftId: shift.id,
      customerId: payload.customerId ?? null,
      customerName: payload.customerName ?? null,
      customerPhone: payload.customerPhone ?? null,
      customerAddress: payload.customerAddress ?? null,
      orderType: payload.orderType, // 'Dine-In' | 'Takeaway' | 'Delivery'
      subtotal,
      taxRate,
      taxAmount,
      deliveryCharge,
      total,
    });

    const orderId = orderInfo.lastInsertRowid;

    for (const line of payload.lines) {
      insertLine.run({
        orderId,
        itemId: line.itemId,
        itemName: line.name,
        itemNameUrdu: line.nameUrdu && String(line.nameUrdu).trim() ? String(line.nameUrdu).trim() : null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        totalPrice: +(line.quantity * line.unitPrice).toFixed(2),
      });
    }

    return orderId;
  });

  const orderId = runTransaction();
  return getOrderWithItems(orderId);
}

function getOrderWithItems(orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const items = db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId);
  return { ...order, items };
}

/**
 * Order History default view: last 24 hours only, cursor-paginated
 * (keyset pagination on id, not OFFSET) so performance stays flat
 * no matter how deep the restaurant's order history grows.
 *
 * @param {object} opts
 * @param {number|null} opts.cursor  id of the last row from the previous page (null = first page)
 * @param {number} opts.limit
 */
function listRecentOrders({ cursor = null, limit = 25 } = {}) {
  const db = getDb();
  const params = { limit };
  let sql = `
    SELECT * FROM orders
    WHERE deleted_at IS NULL AND created_at >= datetime('now', '-24 hours')
  `;
  if (cursor) {
    sql += ' AND id < @cursor';
    params.cursor = cursor;
  }
  sql += ' ORDER BY id DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params);
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, nextCursor };
}

/**
 * Explicit historical lookup for anything older than 24h. This is a
 * DIFFERENT code path from listRecentOrders on purpose: the default
 * view must never accidentally widen into a full table scan just
 * because someone changed a shared query builder.
 *
 * `search` (optional) matches against order #, customer name, or
 * customer phone - it narrows whatever date range is already active,
 * it never replaces it.
 */
function listOrdersByDateRange({ startDate, endDate, page = 1, pageSize = 25, search = null }) {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const params = { startDate, endDate, pageSize, offset };

  // startDate/endDate arrive as naive LOCAL "YYYY-MM-DD HH:MM:SS" strings
  // (see src/shell/businessDay.js formatLocal), but orders.created_at is
  // stored in UTC (DEFAULT datetime('now')). datetime(x, 'utc') converts
  // the local bound to UTC first - without it the comparison is off by
  // the timezone offset (+5h in Pakistan), which is what split a business
  // day at 8 PM instead of at the Settings day-start time.
  let whereClause = `WHERE deleted_at IS NULL
    AND created_at >= datetime(@startDate, 'utc')
    AND created_at <= datetime(@endDate, 'utc')`;
  if (search) {
    whereClause += ` AND (
      CAST(id AS TEXT) LIKE @search
      OR customer_name LIKE @search
      OR customer_phone LIKE @search
    )`;
    params.search = `%${search}%`;
  }

  const rows = db
    .prepare(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT @pageSize OFFSET @offset`)
    .all(params);

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${whereClause}`).get(params);

  return { rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/**
 * Page-paginated order history for a single customer's profile.
 * Deliberately OFFSET-paginated (not cursor-based) like
 * listOrdersByDateRange - a customer's own history is small enough
 * that "View next page" numbered pagination is the friendlier fit.
 *
 * Excludes soft-deleted orders, same as every other history/reports
 * read path - a Danger Zone wipe hides an order everywhere it would
 * normally surface, even though the row (and the customer it belongs
 * to) is still intact in the database.
 */
function listOrdersByCustomer(customerId, { page = 1, pageSize = 10 } = {}) {
  const db = getDb();
  const offset = (page - 1) * pageSize;

  const rows = db
    .prepare(
      `SELECT * FROM orders
       WHERE customer_id = @customerId AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT @pageSize OFFSET @offset`
    )
    .all({ customerId, pageSize, offset });

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM orders WHERE customer_id = @customerId AND deleted_at IS NULL`)
    .get({ customerId });

  return { rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function voidOrder(orderId) {
  const db = getDb();
  const info = db
    .prepare(`UPDATE orders SET status = 'VOID' WHERE id = ? AND status != 'VOID'`)
    .run(orderId);
  if (info.changes === 0) throw new Error(`Order #${orderId} not found or already void.`);
  return getOrderWithItems(orderId);
}

function dangerRangeWhereClause({ startDate = null, endDate = null } = {}) {
  const params = {};
  // Only ever counts/touches orders that aren't already soft-deleted,
  // so re-running this over an overlapping range never double-counts
  // or re-stamps rows a previous Danger Zone action already hid.
  let whereClause = 'WHERE deleted_at IS NULL';
  if (startDate) {
    whereClause += " AND created_at >= datetime(@startDate, 'utc')";
    params.startDate = startDate;
  }
  if (endDate) {
    whereClause += " AND created_at <= datetime(@endDate, 'utc')";
    params.endDate = endDate;
  }
  return { whereClause, params };
}

/**
 * Settings > Danger Zone: preview how many orders a delete would hide
 * from History/Reports, before the user commits to it. Omitting both
 * dates counts everything ("All Time").
 */
function countOrdersInRange({ startDate = null, endDate = null } = {}) {
  const db = getDb();
  const { whereClause, params } = dangerRangeWhereClause({ startDate, endDate });
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${whereClause}`).get(params);
  return total;
}

/**
 * Settings > Danger Zone: SOFT-deletes orders in the given range -
 * stamps deleted_at instead of running a real SQL DELETE. The order
 * (and order_items) rows stay in the database untouched; only the
 * timestamp changes. Nothing about the customer record, or that
 * customer's ability to be found/looked up, is touched by this at all.
 *
 * Order History, Reports & Analytics, and a customer's own order list
 * are all just different views over this same orders/order_items data
 * (Reports has no storage of its own - every figure in analytics.js is
 * computed live from these same rows), and every one of those read
 * paths filters WHERE deleted_at IS NULL. So stamping it here is
 * genuinely enough to clear the order out of all of them at once,
 * without the underlying customer data ever going anywhere.
 */
function deleteOrdersInRange({ startDate = null, endDate = null } = {}) {
  const db = getDb();
  const { whereClause, params } = dangerRangeWhereClause({ startDate, endDate });
  const info = db
    .prepare(`UPDATE orders SET deleted_at = datetime('now') ${whereClause}`)
    .run(params);
  return { deleted: info.changes };
}

/**
 * Hidden Records view (Ctrl+K -> type "hide" -> gatekeeper). It shows
 * EVERY order, not only the soft-deleted ones:
 *   - live orders     (deleted_at IS NULL)     - still visible in the
 *                                                normal Order History
 *   - hidden orders   (deleted_at IS NOT NULL) - wiped from History &
 *                                                Reports by Danger Zone
 * `scope` narrows it: 'all' (default) | 'live' | 'deleted'. Each row
 * carries deleted_at, so the UI can badge it Live / Hidden.
 *
 * Hidden Records is also the only place a HARD delete can be started
 * (permanentlyDeleteOrders below) - it can remove either kind.
 *
 * `search` mirrors listOrdersByDateRange's matching (order #, customer
 * name, or customer phone). Date bounds are naive LOCAL strings, same
 * as Order History, and are converted to UTC for the comparison.
 */
function listDeletedOrders({ startDate = null, endDate = null, page = 1, pageSize = 25, search = null, scope = 'all' } = {}) {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const params = { pageSize, offset };

  let whereClause = 'WHERE 1 = 1';
  if (scope === 'live') whereClause += ' AND deleted_at IS NULL';
  else if (scope === 'deleted') whereClause += ' AND deleted_at IS NOT NULL';
  if (startDate) {
    whereClause += " AND created_at >= datetime(@startDate, 'utc')";
    params.startDate = startDate;
  }
  if (endDate) {
    whereClause += " AND created_at <= datetime(@endDate, 'utc')";
    params.endDate = endDate;
  }
  if (search) {
    whereClause += ` AND (
      CAST(id AS TEXT) LIKE @search
      OR customer_name LIKE @search
      OR customer_phone LIKE @search
    )`;
    params.search = `%${search}%`;
  }

  const orderBy = scope === 'deleted' ? 'deleted_at DESC, created_at DESC' : 'created_at DESC, id DESC';
  const rows = db
    .prepare(`SELECT * FROM orders ${whereClause} ORDER BY ${orderBy} LIMIT @pageSize OFFSET @offset`)
    .all(params);

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${whereClause}`).get(params);

  return { rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/**
 * Hidden Records "Manage" mode: a genuine, irreversible SQL DELETE.
 *
 * Danger Zone only ever SOFT-deletes (deleted_at stamp). This is the
 * only hard delete in the app, reachable only from Hidden Records
 * (behind the gatekeeper password + a typed DELETE confirmation), and
 * it removes whichever orders were ticked - live or already hidden.
 *
 * order_items cascades automatically (ON DELETE CASCADE, see
 * schema.sql) and nothing else references orders, so removing the
 * order row is a complete, clean removal. Customer profiles are never
 * touched. Note: removing a live order also removes it from its
 * shift's sales total (shifts.js getShiftSalesTotal).
 *
 * @param {number[]} orderIds
 */
function permanentlyDeleteOrders(orderIds) {
  const db = getDb();
  const ids = Array.from(new Set((orderIds || []).map(Number))).filter((n) => Number.isInteger(n));
  if (ids.length === 0) return { deleted: 0 };

  // Chunked so a very large selection can't hit SQLite's bound-variable limit.
  const CHUNK = 500;
  const run = db.transaction(() => {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const placeholders = part.map(() => '?').join(', ');
      deleted += db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...part).changes;
    }
    return deleted;
  });
  return { deleted: run() };
}

module.exports = {
  createOrder,
  getOrderWithItems,
  listRecentOrders,
  listOrdersByDateRange,
  listOrdersByCustomer,
  voidOrder,
  countOrdersInRange,
  deleteOrdersInRange,
  listDeletedOrders,
  permanentlyDeleteOrders,
};
