'use strict';

const { getDb } = require('../db');
const { normalizePhone } = require('../../utils/phone');

// Thresholds behind the Customer Database "Regular" / "High Spender"
// filters. Tuneable in one place if a restaurant's definition differs.
const REGULAR_MIN_ORDERS = 3;
const HIGH_SPENDER_MIN_TOTAL = 5000;

/** Exact-string lookup - kept for anything that genuinely wants the
 *  raw stored value. Prefer findByNormalizedPhone() for anything that
 *  matches a phone a person just typed (see electron/utils/phone.js -
 *  "0300 1234567" and "+92 300 1234567" are the same customer). */
function findByPhone(phone) {
  const db = getDb();
  return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) || null;
}

/** Format-tolerant lookup: matches regardless of spaces, dashes, a
 *  leading "0" vs "92" vs "+92", etc. This is what "type a phone,
 *  auto-fill if known" (New Order) and duplicate detection should
 *  always use - a raw findByPhone() would treat every formatting
 *  variant as a different customer. */
function findByNormalizedPhone(phone) {
  const db = getDb();
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM customers WHERE phone_normalized = ?').get(normalized) || null;
}

function getCustomerWithAddresses(id) {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return null;
  const addresses = db
    .prepare('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id')
    .all(id);
  return { ...customer, addresses };
}

/** Used by New Order screen: type a phone number, auto-fill if known. */
function upsertCustomer({ name, phone }) {
  const db = getDb();
  const existing = findByNormalizedPhone(phone) || findByPhone(phone);
  if (existing) {
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name, existing.id);
    return getCustomerWithAddresses(existing.id);
  }
  const info = db
    .prepare('INSERT INTO customers (name, phone, phone_normalized) VALUES (?, ?, ?)')
    .run(name, phone, normalizePhone(phone));
  return getCustomerWithAddresses(info.lastInsertRowid);
}

/**
 * Explicit edit path from the Customer Profile screen - distinct from
 * upsertCustomer() above, which is keyed BY phone (for the "auto-fill
 * from a known number" flow) and can't be used to change an existing
 * customer's own phone number. This checks uniqueness up front and
 * throws a friendly error instead of colliding with the UNIQUE index.
 */
function updateCustomer(id, { name, phone }) {
  const db = getDb();
  const existing = getCustomerWithAddresses(id);
  if (!existing) {
    throw new Error(`Customer #${id} not found.`);
  }
  const nextName = (name ?? existing.name).trim();
  const nextPhone = (phone ?? existing.phone).trim();
  if (!nextName || !nextPhone) {
    throw new Error('Name and phone number are both required.');
  }
  const nextNormalized = normalizePhone(nextPhone);
  if (nextNormalized !== existing.phone_normalized) {
    const dupe = findByNormalizedPhone(nextPhone);
    if (dupe && dupe.id !== id) {
      throw new Error(`Phone number ${nextPhone} already belongs to "${dupe.name}".`);
    }
  }
  db.prepare('UPDATE customers SET name = ?, phone = ?, phone_normalized = ? WHERE id = ?').run(
    nextName,
    nextPhone,
    nextNormalized,
    id
  );
  return getCustomerWithAddresses(id);
}

/**
 * Finds groups of customer rows that normalize to the same phone
 * number - i.e. pre-existing duplicate profiles created before
 * normalized matching existed (or from a manual data-entry mistake).
 * Nothing here merges or deletes anything; the Customer Database
 * screen uses this to flag rows for a manager to review and merge by
 * hand, since combining two profiles also means moving order history
 * between them - not something to do silently.
 */
function findDuplicateCustomerGroups() {
  const db = getDb();
  const groups = db
    .prepare(
      `SELECT phone_normalized, COUNT(*) AS cnt
       FROM customers
       WHERE phone_normalized IS NOT NULL AND phone_normalized != ''
       GROUP BY phone_normalized
       HAVING cnt > 1`
    )
    .all();
  if (groups.length === 0) return [];

  const memberStmt = db.prepare(
    `SELECT id, name, phone, created_at FROM customers WHERE phone_normalized = ? ORDER BY id`
  );
  return groups.map((g) => ({
    phoneNormalized: g.phone_normalized,
    members: memberStmt.all(g.phone_normalized),
  }));
}

function addAddress(customerId, { label = null, address, isDefault = false }) {
  const db = getDb();

  const runTransaction = db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?').run(customerId);
    }
    db.prepare(
      `INSERT INTO customer_addresses (customer_id, label, address, is_default)
       VALUES (?, ?, ?, ?)`
    ).run(customerId, label, address, isDefault ? 1 : 0);
  });
  runTransaction();

  return getCustomerWithAddresses(customerId);
}

/**
 * Cursor-paginated directory listing for the Customers Database screen.
 * Each row is annotated with order_count / total_spent (COMPLETED
 * orders only) so the list page can show and filter on spend/loyalty
 * without a separate round trip per row.
 *
 * @param {object} opts
 * @param {string|null} opts.search
 * @param {number|null} opts.cursor
 * @param {number} opts.limit
 * @param {'all'|'regular'|'high_spender'|'new'|'inactive'} opts.filter
 *   'new': added to the directory in the last INACTIVE_WINDOW_DAYS days.
 *   'inactive': never ordered, or last order was more than
 *   INACTIVE_WINDOW_DAYS days ago - the "win them back" list for the
 *   WhatsApp Deal Sender's quick filters.
 */
const INACTIVE_WINDOW_DAYS = 30;

function listCustomers({ search = null, cursor = null, limit = 30, filter = 'all' } = {}) {
  const db = getDb();
  const params = { limit };
  let sql = `
    SELECT c.*,
      COUNT(CASE WHEN o.status = 'COMPLETED' THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN o.status = 'COMPLETED' THEN o.total END), 0) AS total_spent,
      MAX(CASE WHEN o.status = 'COMPLETED' THEN o.created_at END) AS last_order_at
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    WHERE 1 = 1
  `;

  if (search) {
    const normalizedSearch = normalizePhone(search);
    if (normalizedSearch) {
      // Search term looks like it has digits in it - also match against
      // phone_normalized so searching "0300 1234" finds a customer
      // stored as "+92 300 1234567" (or any other format) too, not
      // just an exact-format substring of the raw phone column.
      sql += ' AND (c.name LIKE @search OR c.phone LIKE @search OR c.phone_normalized LIKE @normalizedSearch)';
      params.normalizedSearch = `%${normalizedSearch}%`;
    } else {
      sql += ' AND (c.name LIKE @search OR c.phone LIKE @search)';
    }
    params.search = `%${search}%`;
  }
  if (cursor) {
    sql += ' AND c.id < @cursor';
    params.cursor = cursor;
  }
  if (filter === 'new') {
    sql += " AND c.created_at >= datetime('now', @newWindow)";
    params.newWindow = `-${INACTIVE_WINDOW_DAYS} days`;
  }
  sql += ' GROUP BY c.id';
  if (filter === 'regular') {
    sql += ' HAVING order_count >= @regularMin';
    params.regularMin = REGULAR_MIN_ORDERS;
  } else if (filter === 'high_spender') {
    sql += ' HAVING total_spent >= @highSpenderMin';
    params.highSpenderMin = HIGH_SPENDER_MIN_TOTAL;
  } else if (filter === 'inactive') {
    sql += " HAVING last_order_at IS NULL OR last_order_at < datetime('now', @inactiveWindow)";
    params.inactiveWindow = `-${INACTIVE_WINDOW_DAYS} days`;
  }
  sql += ' ORDER BY c.id DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params);
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;

  // Attach each customer's addresses - a small extra query per row,
  // which is fine at this page size (<=30) and keeps the shape
  // consistent with getCustomerWithAddresses() so the UI never has to
  // special-case "list view" vs "detail view" customer objects.
  const addressStmt = db.prepare(
    'SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id'
  );
  const rowsWithAddresses = rows.map((row) => ({ ...row, addresses: addressStmt.all(row.id) }));

  return { rows: rowsWithAddresses, nextCursor };
}

/**
 * Everything Customer Profile needs beyond the base row: lifetime
 * totals, their top 5 items by revenue, and a monthly spend
 * breakdown for the profile's mini chart.
 */
function getCustomerStats(customerId) {
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS order_count,
              COALESCE(SUM(total), 0) AS total_spent,
              MIN(created_at) AS first_order_at,
              MAX(created_at) AS last_order_at
       FROM orders WHERE customer_id = ? AND status = 'COMPLETED'`
    )
    .get(customerId);

  const topItems = db
    .prepare(
      `SELECT oi.item_name_snapshot AS name, SUM(oi.quantity) AS quantity, SUM(oi.total_price) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.customer_id = ? AND o.status = 'COMPLETED'
       GROUP BY oi.item_name_snapshot
       ORDER BY revenue DESC
       LIMIT 5`
    )
    .all(customerId);

  const monthlySpend = db
    .prepare(
      `SELECT strftime('%Y-%m', created_at) AS month, SUM(total) AS total
       FROM orders
       WHERE customer_id = ? AND status = 'COMPLETED'
       GROUP BY month
       ORDER BY month ASC`
    )
    .all(customerId)
    .slice(-6);

  return { ...totals, topItems, monthlySpend };
}

/**
 * Genuine hard delete: the customer row (and via ON DELETE CASCADE,
 * their saved addresses) is gone for good - not soft-deleted, not
 * recoverable from Hidden Records. Their past orders are detached
 * (customer_id set to NULL) rather than blocked or cascade-deleted,
 * since every order already snapshots customer_name/customer_phone/
 * customer_address at the time of sale (same reasoning as
 * order_items.item_name_snapshot) - so Order History and Reports &
 * Analytics keep showing exactly what was sold, just no longer linked
 * to a customer profile that no longer exists.
 */
function deleteCustomer(id) {
  const db = getDb();
  const runTransaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
    if (!existing) throw new Error(`Customer #${id} not found.`);
    db.prepare('UPDATE orders SET customer_id = NULL WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });
  runTransaction();
  return true;
}

module.exports = {
  findByPhone,
  findByNormalizedPhone,
  findDuplicateCustomerGroups,
  getCustomerWithAddresses,
  upsertCustomer,
  updateCustomer,
  deleteCustomer,
  addAddress,
  listCustomers,
  getCustomerStats,
  REGULAR_MIN_ORDERS,
  HIGH_SPENDER_MIN_TOTAL,
  INACTIVE_WINDOW_DAYS,
};
