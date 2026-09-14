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

  let whereClause = 'WHERE deleted_at IS NULL AND created_at >= @startDate AND created_at <= @endDate';
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
    whereClause += ' AND created_at >= @startDate';
    params.startDate = startDate;
  }
  if (endDate) {
    whereClause += ' AND created_at <= @endDate';
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
 * Hidden Records view (Ctrl+K -> type "hide" -> gatekeeper): the
 * read-only mirror of Order History, but scoped to exactly the
 * opposite set of rows - orders a Danger Zone wipe has soft-deleted
 * (deleted_at IS NOT NULL) instead of the ones every other screen
 * shows (deleted_at IS NULL). Nothing here is restored or un-deleted;
 * this only lets an admin look at what a wipe hid, the same way
 * Order History lets them look at what's still active.
 *
 * `search` mirrors listOrdersByDateRange's matching (order #, customer
 * name, or customer phone). Date range is optional here - omitting
 * both means "every soft-deleted order, all time", which is the
 * natural default for a recycle-bin-style view.
 */
function listDeletedOrders({ startDate = null, endDate = null, page = 1, pageSize = 25, search = null } = {}) {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const params = { pageSize, offset };

  let whereClause = 'WHERE deleted_at IS NOT NULL';
  if (startDate) {
    whereClause += ' AND created_at >= @startDate';
    params.startDate = startDate;
  }
  if (endDate) {
    whereClause += ' AND created_at <= @endDate';
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

  const rows = db
    .prepare(`SELECT * FROM orders ${whereClause} ORDER BY deleted_at DESC, created_at DESC LIMIT @pageSize OFFSET @offset`)
    .all(params);

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${whereClause}`).get(params);

  return { rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
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
};
