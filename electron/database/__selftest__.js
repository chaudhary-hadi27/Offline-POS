'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { initDatabase, closeDatabase } = require('./db');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-selftest-'));
initDatabase(tmpDir);

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

console.log('Running Phase 1 self-test against', tmpDir);

check('cannot create order without an open shift', () => {
  assert.throws(() => orders.createOrder({ orderType: 'Dine-In', lines: [] }));
});

let shift;
check('open a shift', () => {
  shift = shifts.openShift({ openedBy: 'manager', openingFloat: 2000 });
  assert.strictEqual(shift.status, 'OPEN');
});

check('cannot open a second shift while one is open', () => {
  assert.throws(() => shifts.openShift({ openingFloat: 500 }));
});

let biryani, cola;
check('create menu items', () => {
  biryani = items.createItem({ sku: 'BR01', name: 'Chicken Biryani', category: 'Rice', price: 450 });
  cola = items.createItem({ sku: 'DR01', name: 'Cola 500ml', category: 'Drinks', price: 120 });
  assert.strictEqual(items.listItems().length, 2);
});

check('duplicate SKU is rejected', () => {
  assert.throws(() => items.createItem({ sku: 'BR01', name: 'Dup', category: 'Rice', price: 1 }));
});

check('toggle item out of stock', () => {
  items.setAvailability(cola.id, false);
  const available = items.listItems({ onlyAvailable: true });
  assert.strictEqual(available.find((i) => i.id === cola.id), undefined);
});

let customer;
check('create customer with a delivery address', () => {
  customer = customers.upsertCustomer({ name: 'Ahmed Raza', phone: '03001234567' });
  customer = customers.addAddress(customer.id, { label: 'Home', address: 'House 12, Street 4, Lahore', isDefault: true });
  assert.strictEqual(customer.addresses.length, 1);
});

let order;
check('create an order with line items (transactional)', () => {
  order = orders.createOrder({
    orderType: 'Delivery',
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerAddress: customer.addresses[0].address,
    taxRate: 5,
    lines: [
      { itemId: biryani.id, name: biryani.name, quantity: 2, unitPrice: biryani.price },
    ],
  });
  assert.strictEqual(order.items.length, 1);
  assert.strictEqual(order.subtotal, 900);
  assert.strictEqual(order.tax_amount, 45);
  assert.strictEqual(order.total, 945);
});

check('order rolls back fully if a line item is invalid', () => {
  const before = orders.listRecentOrders().rows.length;
  assert.throws(() =>
    orders.createOrder({
      orderType: 'Dine-In',
      lines: [{ itemId: biryani.id, name: 'x', quantity: 0, unitPrice: 10 }], // quantity > 0 CHECK fails
    })
  );
  const after = orders.listRecentOrders().rows.length;
  assert.strictEqual(before, after, 'a failed order must not leave a partial row behind');
});

check('order shows up in last-24h history', () => {
  const { rows } = orders.listRecentOrders({ limit: 10 });
  assert.ok(rows.some((r) => r.id === order.id));
});

check('reprint fetches full order + items', () => {
  const full = orders.getOrderWithItems(order.id);
  assert.strictEqual(full.items[0].item_name_snapshot, 'Chicken Biryani');
});

check('security lock: set + verify PIN, wrong PIN fails', () => {
  security.setLock({ lockType: 'PIN', credential: '2468', securityQuestion: 'First school name?', securityAnswer: 'City School' });
  assert.strictEqual(security.verifyCredential('2468'), true);
  assert.strictEqual(security.verifyCredential('0000'), false);
});

check('security question answer is case/space insensitive', () => {
  assert.strictEqual(security.verifySecurityAnswer('  city school  '), true);
  assert.strictEqual(security.verifySecurityAnswer('wrong'), false);
});

check('settings read/write', () => {
  settings.setSettings({ restaurant_name: 'Bilal Broast', default_tax_rate: '5' });
  const all = settings.getAllSettings();
  assert.strictEqual(all.restaurant_name, 'Bilal Broast');
  assert.strictEqual(all.default_tax_rate, '5');
});

check('close shift computes variance', () => {
  const closed = shifts.closeShift(shift.id, { closingCash: 2900 });
  // opening_float 2000 + order total 945 = 2945 expected
  assert.strictEqual(closed.expected_cash, 2945);
  assert.strictEqual(closed.variance, 2900 - 2945);
  assert.strictEqual(closed.status, 'CLOSED');
});

check('deleting an item referenced by an order is blocked by FK', () => {
  assert.throws(() => items.deleteItem(biryani.id));
});

closeDatabase();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nAll ${pass} checks passed.`);
