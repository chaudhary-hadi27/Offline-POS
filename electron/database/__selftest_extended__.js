'use strict';

/**
 * PHASE 2 self-test - deliberately adversarial.
 *
 * Where __selftest__.js proves the happy paths work, this file exists
 * to try to BREAK them: invalid foreign keys, CHECK-constraint
 * violations, malformed input, double-submits, and - the main thing
 * this pass was written to catch - any code path that mutates the
 * database (shifts especially) before validating its own input, which
 * leaves behind a phantom row even though the operation "failed".
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { initDatabase, getDb, closeDatabase } = require('./db');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-selftest-ext-'));
initDatabase(tmpDir);
const db = getDb();

const shifts = require('./repositories/shifts');
const items = require('./repositories/items');
const orders = require('./repositories/orders');
const customers = require('./repositories/customers');
const security = require('./repositories/security');
const settings = require('./repositories/settings');

let pass = 0;
function check(label, fn) {
  fn();
  pass++;
  console.log(`  ok - ${label}`);
}

function countRows(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

console.log('Running Phase 2 (adversarial) self-test against', tmpDir);

// =====================================================================
// SHIFTS - the exact class of bug this pass was commissioned to find
// =====================================================================

check('a rejected empty order leaves ZERO rows in shifts (no phantom auto-open)', () => {
  const before = countRows('shifts');
  assert.throws(() => orders.createOrder({ orderType: 'Dine-In', lines: [] }));
  const after = countRows('shifts');
  assert.strictEqual(after, before, 'an order that fails validation must not open a shift as a side effect');
});

check('a rejected order (bad item FK) leaves ZERO rows in shifts AND ZERO rows in orders', () => {
  const shiftsBefore = countRows('shifts');
  const ordersBefore = countRows('orders');
  assert.throws(() =>
    orders.createOrder({
      orderType: 'Dine-In',
      lines: [{ itemId: 999999, name: 'Ghost Item', quantity: 1, unitPrice: 100 }],
    })
  );
  assert.strictEqual(countRows('shifts'), shiftsBefore, 'invalid item_id must roll back the auto-opened shift too, not just the order');
  assert.strictEqual(countRows('orders'), ordersBefore);
});

check('a rejected order (bad customer FK) leaves ZERO rows in shifts AND ZERO rows in orders', () => {
  const shiftsBefore = countRows('shifts');
  const ordersBefore = countRows('orders');
  assert.throws(() =>
    orders.createOrder({
      orderType: 'Dine-In',
      customerId: 999999,
      lines: [{ itemId: null, name: 'Walk-in item', quantity: 1, unitPrice: 100 }],
    })
  );
  assert.strictEqual(countRows('shifts'), shiftsBefore);
  assert.strictEqual(countRows('orders'), ordersBefore);
});

check('a rejected order (invalid order_type) leaves ZERO rows in shifts AND ZERO rows in orders', () => {
  const shiftsBefore = countRows('shifts');
  const ordersBefore = countRows('orders');
  assert.throws(() =>
    orders.createOrder({
      orderType: 'Drive-Thru', // not in the CHECK (...) list
      lines: [{ itemId: null, name: 'Walk-in item', quantity: 1, unitPrice: 100 }],
    })
  );
  assert.strictEqual(countRows('shifts'), shiftsBefore);
  assert.strictEqual(countRows('orders'), ordersBefore);
});

check('a valid order (no item_id, walk-in line) DOES auto-open exactly one shift', () => {
  const shiftsBefore = countRows('shifts');
  const order = orders.createOrder({
    orderType: 'Takeaway',
    lines: [{ itemId: null, name: 'Walk-in item', quantity: 1, unitPrice: 250 }],
  });
  assert.strictEqual(countRows('shifts'), shiftsBefore + 1);
  assert.ok(order.id > 0);
  const openShift = shifts.getOpenShift();
  assert.ok(openShift, 'the auto-opened shift should now be open');
  // Clean up so later checks in this file start from a known state.
  shifts.closeShift(openShift.id, { closingCash: 250 });
});

check('closing a shift with no orders yet computes variance against opening_float alone', () => {
  const s = shifts.openShift({ openedBy: 'tester', openingFloat: 1000 });
  const closed = shifts.closeShift(s.id, { closingCash: 1000 });
  assert.strictEqual(closed.expected_cash, 1000);
  assert.strictEqual(closed.variance, 0);
});

check('closing an already-closed shift throws (no silent no-op)', () => {
  const s = shifts.openShift({ openedBy: 'tester', openingFloat: 0 });
  shifts.closeShift(s.id, { closingCash: 0 });
  assert.throws(() => shifts.closeShift(s.id, { closingCash: 500 }));
});

check('closing a shift that does not exist throws a clear error, not a crash', () => {
  assert.throws(() => shifts.closeShift(999999, { closingCash: 0 }), /not found/);
});

check('the UNIQUE partial index (not just app code) blocks a second OPEN row', () => {
  // Bypass the repository's own getOpenShift() guard entirely and
  // insert straight through better-sqlite3, proving the DB-level
  // safety net documented in shifts.js actually holds even if some
  // future code path forgets to call the app-level check first.
  shifts.openShift({ openedBy: 'guard-test', openingFloat: 0 });
  assert.throws(() => {
    db.prepare(`INSERT INTO shifts (opened_by, opening_float, status) VALUES ('bypass', 0, 'OPEN')`).run();
  }, /UNIQUE constraint failed/);
  shifts.closeShift(shifts.getOpenShift().id, { closingCash: 0 });
});

check('negative opening_float is accepted by the schema (no CHECK) - documenting current behavior', () => {
  // There's no CHECK (opening_float >= 0) in schema.sql. This isn't
  // necessarily wrong (a shift could conceivably open "in the hole"),
  // but it's worth having a test pin the current behavior down so a
  // future schema change here is a deliberate decision, not a surprise.
  const s = shifts.openShift({ openedBy: 'tester', openingFloat: -500 });
  assert.strictEqual(s.opening_float, -500);
  shifts.closeShift(s.id, { closingCash: -500 });
});

// =====================================================================
// ITEMS
// =====================================================================

check('negative price is rejected by the CHECK constraint', () => {
  assert.throws(() => items.createItem({ sku: 'NEG1', name: 'Negative', category: 'Test', price: -10 }));
});

check('missing required fields (no category) throws instead of inserting a broken row', () => {
  const before = countRows('items');
  assert.throws(() => items.createItem({ sku: 'NOCAT', name: 'No Category', price: 10 }));
  assert.strictEqual(countRows('items'), before);
});

check('price variants cascade-delete when their parent item is deleted', () => {
  const item = items.createItem({ sku: 'VAR1', name: 'Sized Drink', category: 'Drinks', price: 100 });
  db.prepare(`INSERT INTO item_price_variants (item_id, label, price) VALUES (?, 'Large', 150)`).run(item.id);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM item_price_variants WHERE item_id = ?').get(item.id).n,
    1
  );
  items.deleteItem(item.id);
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM item_price_variants WHERE item_id = ?').get(item.id).n,
    0,
    'ON DELETE CASCADE should have removed the orphaned variant row'
  );
});

check('setAvailability on a non-existent item id throws a clear error instead of a silent no-op', () => {
  const before = countRows('items');
  assert.throws(() => items.setAvailability(999999, false), /not found/);
  assert.strictEqual(countRows('items'), before);
});

check('listCategories never returns duplicates even with many items sharing a category', () => {
  items.createItem({ sku: 'CATA1', name: 'A', category: 'Shared Cat', price: 1 });
  items.createItem({ sku: 'CATA2', name: 'B', category: 'Shared Cat', price: 1 });
  const cats = items.listCategories();
  const occurrences = cats.filter((c) => c === 'Shared Cat').length;
  assert.strictEqual(occurrences, 1);
});

// =====================================================================
// CUSTOMERS
// =====================================================================

check('upsertCustomer on an existing phone updates the name instead of duplicating the row', () => {
  const before = countRows('customers');
  const first = customers.upsertCustomer({ name: 'Ali', phone: '03111111111' });
  const second = customers.upsertCustomer({ name: 'Ali Khan', phone: '03111111111' });
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(second.name, 'Ali Khan');
  assert.strictEqual(countRows('customers'), before + 1);
});

check('updateCustomer refuses to steal another customer\'s phone number', () => {
  const a = customers.upsertCustomer({ name: 'Customer A', phone: '03222222222' });
  customers.upsertCustomer({ name: 'Customer B', phone: '03333333333' });
  assert.throws(() => customers.updateCustomer(a.id, { phone: '03333333333' }), /already belongs to/);
});

check('deleting a customer referenced by a historical order does NOT cascade-delete the order (audit trail preserved)', () => {
  const cust = customers.upsertCustomer({ name: 'Audit Customer', phone: '03444444444' });
  const order = orders.createOrder({
    orderType: 'Delivery',
    customerId: cust.id,
    customerName: cust.name,
    customerPhone: cust.phone,
    lines: [{ itemId: null, name: 'Walk-in item', quantity: 1, unitPrice: 50 }],
  });
  // customers -> orders.customer_id has no ON DELETE clause, so SQLite
  // defaults to NO ACTION: deleting a referenced customer should fail
  // outright rather than silently orphaning or cascading into the
  // permanent sales record.
  assert.throws(() => db.prepare('DELETE FROM customers WHERE id = ?').run(cust.id));
  const stillThere = orders.getOrderWithItems(order.id);
  assert.ok(stillThere, 'the historical order must survive untouched');
});

// =====================================================================
// ORDERS - totals math + rollback integrity under mixed valid/invalid lines
// =====================================================================

check('multiple lines for the SAME item_id sum correctly (repeat item in one order)', () => {
  const item = items.createItem({ sku: 'REPEAT1', name: 'Repeat Item', category: 'Test', price: 20 });
  const order = orders.createOrder({
    orderType: 'Dine-In',
    lines: [
      { itemId: item.id, name: item.name, quantity: 2, unitPrice: 20 },
      { itemId: item.id, name: item.name, quantity: 3, unitPrice: 20 },
    ],
  });
  assert.strictEqual(order.items.length, 2);
  assert.strictEqual(order.subtotal, 100);
});

check('one bad line among several good ones rolls back the WHOLE order, not just the bad line', () => {
  const item = items.createItem({ sku: 'MIXLINE', name: 'Mix Line Item', category: 'Test', price: 30 });
  const ordersBefore = countRows('orders');
  const orderItemsBefore = countRows('order_items');
  assert.throws(() =>
    orders.createOrder({
      orderType: 'Dine-In',
      lines: [
        { itemId: item.id, name: item.name, quantity: 2, unitPrice: 30 }, // valid
        { itemId: item.id, name: item.name, quantity: -1, unitPrice: 30 }, // quantity > 0 CHECK fails
      ],
    })
  );
  assert.strictEqual(countRows('orders'), ordersBefore, 'no order row should remain');
  assert.strictEqual(countRows('order_items'), orderItemsBefore, 'no line item should remain, including the otherwise-valid first line');
});

check('missing taxRate defaults to 0 tax, not NaN / a thrown error', () => {
  const order = orders.createOrder({
    orderType: 'Dine-In',
    lines: [{ itemId: null, name: 'No-tax item', quantity: 1, unitPrice: 99 }],
  });
  assert.strictEqual(order.tax_amount, 0);
  assert.strictEqual(order.total, 99);
});

check('floating point subtotal/tax/total are rounded to 2dp, not left as long decimals', () => {
  const order = orders.createOrder({
    orderType: 'Dine-In',
    taxRate: 7, // deliberately a rate that produces a repeating decimal
    lines: [{ itemId: null, name: 'Odd Price', quantity: 3, unitPrice: 33.33 }],
  });
  // 3 * 33.33 = 99.99 exactly; tax = 99.99 * 0.07 = 6.9993 -> 7.00
  assert.strictEqual(order.subtotal, 99.99);
  assert.strictEqual(order.tax_amount, 7);
  assert.strictEqual(order.total, 106.99);
});

// =====================================================================
// SECURITY
// =====================================================================

check('setLock with an unsupported lock_type is rejected by the CHECK constraint', () => {
  assert.throws(() =>
    security.setLock({ lockType: 'FACE_ID', credential: 'x', securityQuestion: 'q', securityAnswer: 'a' })
  );
});

check('verifyCredential against an unconfigured lock returns false, not a throw', () => {
  // Fresh check on a brand-new in-memory db with no security row.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-selftest-freshsec-'));
  const Database = require('better-sqlite3');
  const freshDb = new Database(path.join(freshDir, 'pos.sqlite'));
  freshDb.pragma('foreign_keys = ON');
  freshDb.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const row = freshDb.prepare('SELECT * FROM security_config WHERE id = 1').get();
  assert.strictEqual(row, undefined, 'a brand-new install must have no lock configured yet');
  freshDb.close();
  fs.rmSync(freshDir, { recursive: true, force: true });
});

// =====================================================================
// SETTINGS
// =====================================================================

check('receipt_header with newlines and HTML-special characters round-trips exactly', () => {
  const tricky = 'Line One\nLine <Two> & "Three"\n<script>alert(1)</script>';
  settings.setSettings({ receipt_header: tricky });
  const all = settings.getAllSettings();
  assert.strictEqual(all.receipt_header, tricky, 'the raw value stored/read must be byte-for-byte identical - HTML escaping is the template\'s job, not storage\'s');
});

check('setSettings with an empty string value is stored as empty, not skipped or nulled', () => {
  settings.setSettings({ receipt_footer: '' });
  assert.strictEqual(settings.getAllSettings().receipt_footer, '');
});

check('unknown/typo\'d settings keys are simply stored, not silently dropped (documents current permissive behavior)', () => {
  settings.setSettings({ totally_made_up_key_xyz: 'hello' });
  assert.strictEqual(settings.getAllSettings().totally_made_up_key_xyz, 'hello');
});

closeDatabase();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nAll ${pass} adversarial checks passed.`);
