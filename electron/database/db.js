'use strict';

/**
 * Database connection singleton.
 *
 * IMPORTANT: This module is only ever require()'d from the Electron
 * MAIN process. The renderer never touches better-sqlite3 directly -
 * it only talks to main via the IPC channels in ipc-channels.js.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

/**
 * @param {string} dbDir Directory the .sqlite file should live in.
 *   In production this is Electron's app.getPath('userData').
 *   The test harness passes a temp dir so we never touch real data.
 */
function initDatabase(dbDir) {
  if (db) return db;

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'pos.sqlite');
  db = new Database(dbPath);

  // --- Performance / durability pragmas ---
  // WAL = readers don't block the writer (cashier printing a receipt
  // shouldn't stall the analytics dashboard's query in another window).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  runMigrations(db);

  return db;
}

/**
 * CREATE TABLE IF NOT EXISTS in schema.sql only helps brand-new
 * databases - it does nothing for a column added to an existing
 * table on an install that's already running. This covers that gap
 * with small, idempotent ALTER TABLE steps guarded by a column-
 * existence check, so upgrading never requires the client to delete
 * their database.
 */
function runMigrations(db) {
  const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!itemColumns.includes('image_path')) {
    db.exec('ALTER TABLE items ADD COLUMN image_path TEXT');
  }
  if (!itemColumns.includes('description')) {
    db.exec('ALTER TABLE items ADD COLUMN description TEXT');
  }
  if (!itemColumns.includes('sort_order')) {
    db.exec('ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    // Existing installs: seed sort_order from id so current (category, name)
    // ordering is preserved on upgrade instead of every item collapsing to 0.
    db.exec('UPDATE items SET sort_order = id WHERE sort_order = 0');
  }
  if (!itemColumns.includes('name_urdu')) {
    db.exec('ALTER TABLE items ADD COLUMN name_urdu TEXT');
  }

  // Receipts must keep printing the Urdu name an item had at the time
  // of sale even if that item is later renamed/deleted - same reasoning
  // as item_name_snapshot above.
  const orderItemColumns = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!orderItemColumns.includes('item_name_urdu_snapshot')) {
    db.exec('ALTER TABLE order_items ADD COLUMN item_name_urdu_snapshot TEXT');
  }

  const customerColumns = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  if (!customerColumns.includes('phone_normalized')) {
    db.exec('ALTER TABLE customers ADD COLUMN phone_normalized TEXT');
    // Backfill every existing row so numbers entered before this
    // column existed (in whatever format they were typed in) still
    // match correctly going forward - see electron/utils/phone.js.
    const { normalizePhone } = require('../utils/phone');
    const rows = db.prepare('SELECT id, phone FROM customers').all();
    const update = db.prepare('UPDATE customers SET phone_normalized = ? WHERE id = ?');
    const backfill = db.transaction(() => {
      for (const row of rows) {
        update.run(normalizePhone(row.phone), row.id);
      }
    });
    backfill();
    // Not a UNIQUE index: pre-existing installs may already have two
    // (or more) customer rows that normalize to the same number - see
    // findDuplicateGroups() in the customers repository, which the
    // Customer Database screen uses to flag them for manual review
    // instead of silently failing to add this index.
    db.exec('CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized ON customers (phone_normalized)');
  }

  // Danger Zone used to be a real SQL DELETE. It's now a soft delete
  // (deleted_at gets stamped instead of the row being removed) so that
  // wiping Order History / Reports & Analytics can never take a
  // customer's record or purchase history down with it. Existing
  // installs need the column added; every existing row defaults to
  // NULL (= not deleted), which is exactly correct.
  const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!orderColumns.includes('deleted_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN deleted_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders (deleted_at)');

  // Flat delivery fee (Settings > Restaurant & Receipt) added to
  // orders.total for order_type = 'Delivery'. Existing installs need
  // the column added; every existing row defaults to 0, which is
  // exactly correct (no receipt gets a delivery charge retroactively
  // added to it).
  if (!orderColumns.includes('delivery_charge')) {
    db.exec('ALTER TABLE orders ADD COLUMN delivery_charge REAL NOT NULL DEFAULT 0');
  }

  // Belt-and-suspenders: guarantee this index exists regardless of
  // whether we got here via a fresh install (column came from
  // schema.sql's CREATE TABLE) or an upgrade (column just got added
  // above). Safe to run unconditionally every startup - IF NOT EXISTS
  // makes it a no-op once created, and by this point in the function
  // the column is guaranteed to exist either way.
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized ON customers (phone_normalized)');

  // WhatsApp campaign "history" moved out of the database entirely -
  // it now lives only in memory + a JSON snapshot (see
  // electron/whatsapp/campaignStore.js). Drop the old tables on any
  // install that still has them so nothing is silently left behind.
  db.exec('DROP TABLE IF EXISTS whatsapp_campaign_recipients');
  db.exec('DROP TABLE IF EXISTS whatsapp_campaigns');
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase(dbDir) first.');
  }
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDatabase, getDb, closeDatabase };
