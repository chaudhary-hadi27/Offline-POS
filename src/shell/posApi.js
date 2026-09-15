'use strict';

/**
 * Inside Electron, preload.js has already attached window.pos before
 * this module ever runs, and every call is backed by real SQLite.
 *
 * Outside Electron (`vite dev` / `vite build` + a plain browser tab),
 * window.pos does not exist. The mock below re-implements the same
 * business rules as the real repositories (single open shift, order
 * requires an open shift, unique SKUs, FK-guarded deletes, etc.) in
 * memory, so the full cashier flow - Menu Setup -> New Order -> Order
 * History - can be built and QA'd with Playwright without spinning up
 * Electron + a real database. It is dev/test tooling only; it never
 * ships inside the packaged app because window.pos always exists there.
 */

import seedMenu from './seedMenu.json';

const usingRealBridge = typeof window !== 'undefined' && !!window.pos;

// Mirrors REGULAR_MIN_ORDERS / HIGH_SPENDER_MIN_TOTAL in
// electron/database/repositories/customers.js, so the Customer
// Database filters behave the same in preview mode as in the real app.
const REGULAR_MIN_ORDERS = 3;
const HIGH_SPENDER_MIN_TOTAL = 5000;
// Mirrors INACTIVE_WINDOW_DAYS in electron/database/repositories/customers.js.
const INACTIVE_WINDOW_DAYS = 30;

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Mirrors electron/utils/phone.js - keeps preview-mode duplicate
 *  detection/matching behaving the same as the real app. */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';
  digits = digits.replace(/^0092/, '').replace(/^92/, '').replace(/^0/, '');
  return digits ? `92${digits}` : '';
}

/** Mirrors slugifySku()/generateUniqueSku() in electron/database/repositories/items.js. */
function slugifyMockSku(name) {
  const slug = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8);
  return slug || 'ITEM';
}

function generateUniqueMockSku(name, state) {
  const base = slugifyMockSku(name);
  const exists = (sku) => state.items.some((i) => i.sku === sku);
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

/** Mirrors replacePriceVariants() in electron/database/repositories/items.js. */
function normalizeVariants(priceVariants) {
  return (priceVariants || [])
    .filter((v) => v && String(v.label).trim() && Number.isFinite(Number(v.price)))
    .map((v, i) => ({ id: i + 1, label: String(v.label).trim(), price: Number(v.price) }));
}

/** Mirrors createItem() in electron/database/repositories/items.js - shared by items.create() and the startup menu seeding below. */
function mockCreateItem(state, mockImageStore, { sku, name, nameUrdu = null, category, price, description = null, isAvailable = true, imageDataUrl, priceVariants = [] }) {
  const finalSku = sku && String(sku).trim() ? String(sku).trim() : generateUniqueMockSku(name, state);
  if (state.items.some((i) => i.sku === finalSku)) {
    throw new Error(`Short code "${finalSku}" is already used by another item.`);
  }
  const id = state.nextItemId++;
  const imagePath = imageDataUrl ? `mock-image-${id}` : null;
  if (imagePath) mockImageStore.set(imagePath, imageDataUrl);
  const item = {
    id,
    sku: finalSku,
    name,
    name_urdu: nameUrdu && String(nameUrdu).trim() ? String(nameUrdu).trim() : null,
    category,
    price,
    description: description && String(description).trim() ? String(description).trim() : null,
    is_available: isAvailable ? 1 : 0,
    image_path: imagePath,
    sort_order: state.items.length,
    priceVariants: normalizeVariants(priceVariants),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.items.push(item);
  return item;
}

function buildMockPreviewReceiptHtml(order, settings) {
  // Deliberately simplified duplicate of electron/print/receiptTemplate.js
  // for preview purposes only - the real Electron app never uses this.
  const lines = order.items
    .map((i) => {
      const displayName = i.item_name_urdu_snapshot || i.item_name_snapshot;
      const dir = i.item_name_urdu_snapshot ? ' dir="rtl"' : '';
      return `<span${dir}>${i.quantity}x ${displayName} — Rs. ${i.total_price.toFixed(2)}</span>`;
    })
    .join('<br/>');
  const customerBlock =
    order.customer_name || order.customer_phone || order.customer_address
      ? `<hr/>
         <p style="font-size:11px;color:#444;letter-spacing:0.5px;margin-bottom:2px;">
           ${order.order_type === 'Delivery' ? 'DELIVER TO' : 'CUSTOMER'}
         </p>
         <p style="margin:2px 0;">
           ${order.customer_name ? `<b>${order.customer_name}</b><br/>` : ''}
           ${order.customer_phone ? `${order.customer_phone}<br/>` : ''}
           ${order.customer_address ? `${order.customer_address}` : ''}
         </p>`
      : '';
  return `<!doctype html><html><body style="font-family:monospace;max-width:320px;margin:24px auto;">
    <h3 style="text-align:center;margin:0;">${settings.restaurant_name || 'Restaurant'}</h3>
    <p style="text-align:center;color:#666;">[PREVIEW MODE - no Electron printer attached]</p>
    <hr/>
    <p style="display:flex;justify-content:space-between;gap:12px;">
      <span><b>Order #${order.id}</b></span><span>${order.created_at}</span>
    </p>
    <p style="text-align:center;font-size:11px;letter-spacing:0.5px;">${order.order_type.toUpperCase()}</p>
    ${customerBlock}
    <hr/>
    <p>${lines}</p>
    <hr/>
    <p>Subtotal: Rs. ${order.subtotal.toFixed(2)}<br/>
       Tax (${order.tax_rate}%): Rs. ${order.tax_amount.toFixed(2)}<br/>
       ${order.delivery_charge ? `Delivery Charge: Rs. ${order.delivery_charge.toFixed(2)}<br/>` : ''}
       <b>Total: Rs. ${order.total.toFixed(2)}</b></p>
    <hr/>
    <p style="text-align:center;">${settings.receipt_footer || 'Thank you!'}</p>
  </body></html>`;
}

function createMock() {
  const state = {
    shift: null,
    items: [],
    orders: [],
    customers: [],
    whatsappTemplates: [],
    customGalleryImages: [], // [{ name, filename }] - see customGallery mock below
    nextItemId: 1,
    nextOrderId: 1,
    nextCustomerId: 1,
    nextWhatsappTemplateId: 1,
    securityConfig: null,
    settings: {
      restaurant_name: 'A1 Bite Pizza',
      default_tax_rate: '0',
      delivery_charge: '0',
      receipt_header: '',
      receipt_footer: 'Thank you for visiting!',
      receipt_width_mm: '80',
      printer_port: '',
      theme_mode: 'light',
      auto_day_start_enabled: '0',
      day_start_time: '15:00',
      day_end_time: '03:00',
    },
  };

  const mockImageStore = new Map(); // relativePath -> dataUrl, mirrors disk storage in preview mode

  // Same starter menu as electron/database/seedItems.js, seeded through
  // the same mockCreateItem() path items.create() uses - so preview mode
  // shows the same default catalog, fully editable/deletable, no
  // separate hardcoded copy of the business logic.
  seedMenu.forEach((entry) => {
    try {
      mockCreateItem(state, mockImageStore, { name: entry.name, nameUrdu: entry.nameUrdu || null, category: entry.category, price: entry.price, description: entry.description || null, priceVariants: entry.priceVariants || [] });
    } catch (err) {
      console.error(`[seed] failed to add starter item "${entry.name}" (preview mode)`, err);
    }
  });

  return {
    shifts: {
      async open({ openedBy = null, openingFloat = 0 } = {}) {
        if (state.shift && state.shift.status === 'OPEN') {
          throw new Error(`A shift (#${state.shift.id}) is already open. Close it before starting a new one.`);
        }
        state.shift = {
          id: 1,
          opened_by: openedBy,
          open_time: nowIso(),
          close_time: null,
          opening_float: openingFloat,
          closing_cash: null,
          expected_cash: null,
          variance: null,
          status: 'OPEN',
        };
        return state.shift;
      },
      async getOpen() {
        return state.shift && state.shift.status === 'OPEN' ? state.shift : null;
      },
      async close(shiftId, { closingCash }) {
        if (!state.shift || state.shift.id !== shiftId) throw new Error(`Shift #${shiftId} not found.`);
        const salesTotal = state.orders
          .filter((o) => o.status === 'COMPLETED')
          .reduce((sum, o) => sum + o.total, 0);
        const expectedCash = state.shift.opening_float + salesTotal;
        state.shift = {
          ...state.shift,
          close_time: nowIso(),
          closing_cash: closingCash,
          expected_cash: expectedCash,
          variance: closingCash - expectedCash,
          status: 'CLOSED',
        };
        return state.shift;
      },
      async autoClose(shiftId) {
        if (!state.shift || state.shift.id !== shiftId) throw new Error(`Shift #${shiftId} not found.`);
        const salesTotal = state.orders
          .filter((o) => o.status === 'COMPLETED')
          .reduce((sum, o) => sum + o.total, 0);
        const expectedCash = state.shift.opening_float + salesTotal;
        state.shift = {
          ...state.shift,
          close_time: nowIso(),
          closing_cash: null,
          expected_cash: expectedCash,
          variance: null,
          status: 'CLOSED',
        };
        return state.shift;
      },
      async list() {
        return state.shift ? [state.shift] : [];
      },
      async getSalesTotal(shiftId) {
        return state.orders
          .filter((o) => o.shift_id === shiftId && o.status === 'COMPLETED')
          .reduce((sum, o) => sum + o.total, 0);
      },
    },

    items: {
      async list({ category = null, onlyAvailable = false } = {}) {
        return state.items
          .filter((i) => (category ? i.category === category : true))
          .filter((i) => (onlyAvailable ? i.is_available === 1 : true))
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
      },
      async listCategories() {
        return [...new Set(state.items.map((i) => i.category))].sort();
      },
      async create(payload) {
        return mockCreateItem(state, mockImageStore, payload);
      },
      /**
       * Persists a drag-and-drop reorder from the New Order screen.
       * `orderedIds` is the complete menu id order the renderer computed
       * client-side; mirrors reorderItems() in the real repository.
       */
      async reorder(orderedIds) {
        orderedIds.forEach((id, index) => {
          const item = state.items.find((i) => i.id === Number(id));
          if (item) item.sort_order = index;
        });
        return state.items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      },
      async update(id, { name, nameUrdu, category, price, description, imageDataUrl, removeImage, priceVariants }) {
        const item = state.items.find((i) => i.id === id);
        if (!item) throw new Error(`Item #${id} not found.`);
        if (name != null) item.name = name;
        if (nameUrdu !== undefined) item.name_urdu = nameUrdu && String(nameUrdu).trim() ? String(nameUrdu).trim() : null;
        if (category != null) item.category = category;
        if (price != null) item.price = price;
        if (description !== undefined) item.description = description && String(description).trim() ? String(description).trim() : null;
        if (imageDataUrl) {
          const imagePath = `mock-image-${id}`;
          mockImageStore.set(imagePath, imageDataUrl);
          item.image_path = imagePath;
        } else if (removeImage) {
          if (item.image_path) mockImageStore.delete(item.image_path);
          item.image_path = null;
        }
        if (priceVariants !== undefined) item.priceVariants = normalizeVariants(priceVariants);
        item.updated_at = nowIso();
        return item;
      },
      async getImage(relativePath) {
        return mockImageStore.get(relativePath) || null;
      },
      async uploadImage(id, dataUrl) {
        const item = state.items.find((i) => i.id === id);
        if (!item) throw new Error(`Item #${id} not found.`);
        const imagePath = `mock-image-${id}`;
        mockImageStore.set(imagePath, dataUrl);
        item.image_path = imagePath;
        return item;
      },
      async setAvailability(id, isAvailable) {
        const item = state.items.find((i) => i.id === id);
        if (!item) throw new Error(`Item #${id} not found.`);
        item.is_available = isAvailable ? 1 : 0;
        return item;
      },
      /**
       * Genuine hard delete, mirroring deleteItem() in
       * electron/database/repositories/items.js: always removes the
       * item, even if it's been sold before. Past order lines keep
       * their own item_name_snapshot/unit_price (that's the whole
       * point of snapshotting them at sale time), so detaching
       * item_id here is just for consistency with the real DB - it
       * never changes what a past receipt shows.
       */
      async remove(id) {
        const idx = state.items.findIndex((i) => i.id === id);
        if (idx === -1) throw new Error(`Item #${id} not found.`);
        if (state.items[idx].image_path) mockImageStore.delete(state.items[idx].image_path);
        state.items.splice(idx, 1);
        state.orders.forEach((o) => {
          o.items.forEach((line) => {
            if (line.item_id === id) line.item_id = null;
          });
        });
        return true;
      },
      async renameCategory(oldName, newName) {
        const from = String(oldName || '').trim();
        const to = String(newName || '').trim();
        if (!from) throw new Error('Category not found.');
        if (!to) throw new Error('New category name cannot be empty.');
        let renamed = 0;
        state.items.forEach((i) => {
          if (i.category === from) {
            i.category = to;
            renamed += 1;
          }
        });
        return { renamed, category: to };
      },
      async deleteCategory(categoryName, { mode, moveTo } = {}) {
        const category = String(categoryName || '').trim();
        if (!category) throw new Error('Category not found.');

        if (mode === 'move') {
          const target = String(moveTo || '').trim();
          if (!target) throw new Error('Choose a category to move these items to.');
          if (target === category) throw new Error('Choose a different category to move these items to.');
          let moved = 0;
          state.items.forEach((i) => {
            if (i.category === category) {
              i.category = target;
              moved += 1;
            }
          });
          return { moved };
        }

        if (mode === 'delete-items') {
          // Same hard-delete guarantee as the single-item remove()
          // above - nothing is "blocked" anymore, everything in the
          // category is genuinely removed.
          const toDelete = state.items.filter((i) => i.category === category);
          let deleted = 0;
          toDelete.forEach((item) => {
            if (item.image_path) mockImageStore.delete(item.image_path);
            state.items = state.items.filter((i) => i.id !== item.id);
            state.orders.forEach((o) => {
              o.items.forEach((line) => {
                if (line.item_id === item.id) line.item_id = null;
              });
            });
            deleted += 1;
          });
          return { deleted, blocked: 0, blockedNames: [] };
        }

        throw new Error('Unknown delete mode.');
      },
    },

    // Preview mode never has the bundled electron/database/seed-images/
    // folder to read from - always reports an empty gallery.
    seedGallery: {
      async list() {
        return [];
      },
      async getImage() {
        return null;
      },
    },

    // In-memory twin of electron/images/customGallery.js - a small,
    // writable, name-tagged gallery so a single saved photo can be
    // matched by Auto-Detect without picking a whole folder. Lives only
    // for the life of this preview session (no disk in the browser).
    customGallery: {
      async list() {
        return state.customGalleryImages.slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
      },
      async categories() {
        const set = new Set(state.customGalleryImages.map((e) => e.category || 'Uncategorized'));
        return [...set].sort((a, b) => a.localeCompare(b));
      },
      async add(name, category, dataUrl) {
        const trimmedName = String(name || '').trim();
        if (!trimmedName) throw new Error('A name is required to save a gallery photo.');
        const trimmedCategory = String(category || '').trim() || 'Uncategorized';
        const key = trimmedName.toLowerCase();
        const filename = `mock-gallery-${key}`;
        mockImageStore.set(filename, dataUrl);
        state.customGalleryImages = state.customGalleryImages.filter((e) => e.name.toLowerCase() !== key);
        const entry = { name: trimmedName, filename, category: trimmedCategory };
        state.customGalleryImages.push(entry);
        return entry;
      },
      async getImage(filename) {
        return mockImageStore.get(filename) || null;
      },
      async remove(filename) {
        mockImageStore.delete(filename);
        state.customGalleryImages = state.customGalleryImages.filter((e) => e.filename !== filename);
        return true;
      },
    },

    orders: {
      async create(payload) {
        // Orders no longer require someone to have pressed "Start Day" first.
        // If no shift is open, one is opened silently behind the scenes so
        // every order still has a shift_id for cash reconciliation later -
        // see electron/database/repositories/orders.js for the real-DB twin
        // of this fallback.
        if (!state.shift || state.shift.status !== 'OPEN') {
          state.shift = {
            id: state.shift ? state.shift.id + 1 : 1,
            opened_by: 'Auto (Order)',
            open_time: nowIso(),
            close_time: null,
            opening_float: 0,
            closing_cash: null,
            expected_cash: null,
            variance: null,
            status: 'OPEN',
          };
        }
        if (!payload.lines || payload.lines.length === 0) {
          throw new Error('Cannot submit an empty order.');
        }
        const subtotal = payload.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
        const taxRate = payload.taxRate ?? 0;
        const taxAmount = +(subtotal * (taxRate / 100)).toFixed(2);
        const deliveryCharge = +(payload.deliveryCharge || 0).toFixed(2);
        const total = +(subtotal + taxAmount + deliveryCharge).toFixed(2);

        const order = {
          id: state.nextOrderId++,
          shift_id: state.shift.id,
          customer_id: payload.customerId ?? null,
          customer_name: payload.customerName ?? null,
          customer_phone: payload.customerPhone ?? null,
          customer_address: payload.customerAddress ?? null,
          order_type: payload.orderType,
          subtotal,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          delivery_charge: deliveryCharge,
          total,
          created_at: nowIso(),
          status: 'COMPLETED',
          deleted_at: null,
          items: payload.lines.map((l) => {
            return {
              item_id: l.itemId,
              item_name_snapshot: l.name,
              item_name_urdu_snapshot: l.nameUrdu && String(l.nameUrdu).trim() ? String(l.nameUrdu).trim() : null,
              quantity: l.quantity,
              unit_price: l.unitPrice,
              total_price: +(l.quantity * l.unitPrice).toFixed(2),
            };
          }),
        };
        state.orders.push(order);
        return order;
      },
      async get(orderId) {
        return state.orders.find((o) => o.id === orderId) || null;
      },
      async listRecent({ cursor = null, limit = 25 } = {}) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        let rows = state.orders
          .filter((o) => !o.deleted_at && new Date(o.created_at.replace(' ', 'T') + 'Z').getTime() >= cutoff)
          .sort((a, b) => b.id - a.id);
        if (cursor) rows = rows.filter((o) => o.id < cursor);
        const page = rows.slice(0, limit);
        return { rows: page, nextCursor: page.length === limit ? page[page.length - 1].id : null };
      },
      async listByRange({ startDate, endDate, page = 1, pageSize = 25, search = null }) {
        const start = new Date(startDate).getTime();
        const end = new Date(endDate).getTime();
        let rows = state.orders
          .filter((o) => {
            if (o.deleted_at) return false;
            const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
            return t >= start && t <= end;
          })
          .sort((a, b) => b.id - a.id);
        if (search) {
          const q = search.toLowerCase();
          rows = rows.filter(
            (o) =>
              String(o.id).includes(q) ||
              (o.customer_name && o.customer_name.toLowerCase().includes(q)) ||
              (o.customer_phone && o.customer_phone.includes(q))
          );
        }
        const offset = (page - 1) * pageSize;
        return {
          rows: rows.slice(offset, offset + pageSize),
          total: rows.length,
          page,
          pageSize,
          totalPages: Math.ceil(rows.length / pageSize),
        };
      },
      async listByCustomer(customerId, { page = 1, pageSize = 10 } = {}) {
        const rows = state.orders.filter((o) => o.customer_id === customerId && !o.deleted_at).sort((a, b) => b.id - a.id);
        const offset = (page - 1) * pageSize;
        return {
          rows: rows.slice(offset, offset + pageSize),
          total: rows.length,
          page,
          pageSize,
          totalPages: Math.ceil(rows.length / pageSize),
        };
      },
      async void(orderId) {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new Error(`Order #${orderId} not found.`);
        order.status = 'VOID';
        return order;
      },
      async dangerCount({ startDate = null, endDate = null } = {}) {
        const start = startDate ? new Date(startDate).getTime() : -Infinity;
        const end = endDate ? new Date(endDate).getTime() : Infinity;
        return state.orders.filter((o) => {
          if (o.deleted_at) return false;
          const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
          return t >= start && t <= end;
        }).length;
      },
      async dangerDelete({ startDate = null, endDate = null } = {}) {
        const start = startDate ? new Date(startDate).getTime() : -Infinity;
        const end = endDate ? new Date(endDate).getTime() : Infinity;
        // Soft delete, mirroring deleteOrdersInRange() in the real
        // repository: stamp deleted_at instead of removing the row, so
        // Hidden Records (below) can still show what got wiped.
        let deleted = 0;
        state.orders.forEach((o) => {
          if (o.deleted_at) return;
          const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
          if (t >= start && t <= end) {
            o.deleted_at = nowIso();
            deleted += 1;
          }
        });
        return { deleted };
      },
      /**
       * Hidden Records history tab (preview-mode twin of
       * listDeletedOrders() in electron/database/repositories/orders.js):
       * the mirror image of listByRange - only orders dangerDelete has
       * soft-deleted, newest deletion first. Date range is optional
       * here; omitting both returns every deleted order, all time.
       */
      async listDeleted({ startDate = null, endDate = null, page = 1, pageSize = 25, search = null } = {}) {
        const start = startDate ? new Date(startDate).getTime() : -Infinity;
        const end = endDate ? new Date(endDate).getTime() : Infinity;
        let rows = state.orders
          .filter((o) => {
            if (!o.deleted_at) return false;
            const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
            return t >= start && t <= end;
          })
          .sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || '') || b.id - a.id);
        if (search) {
          const q = search.toLowerCase();
          rows = rows.filter(
            (o) =>
              String(o.id).includes(q) ||
              (o.customer_name && o.customer_name.toLowerCase().includes(q)) ||
              (o.customer_phone && o.customer_phone.includes(q))
          );
        }
        const offset = (page - 1) * pageSize;
        return {
          rows: rows.slice(offset, offset + pageSize),
          total: rows.length,
          page,
          pageSize,
          totalPages: Math.ceil(rows.length / pageSize),
        };
      },
      /**
       * Hidden Records -> History -> Manage (preview-mode twin of
       * permanentlyDeleteOrders() in electron/database/repositories/orders.js):
       * a real removal from state.orders, not another soft-delete
       * stamp. Only ever removes ids that are already soft-deleted -
       * mirrors the real repository's WHERE deleted_at IS NOT NULL
       * guard, so this can't be used to hard-delete a live order here
       * either.
       */
      async hardDelete(orderIds) {
        const ids = new Set((orderIds || []).map(Number));
        const before = state.orders.length;
        state.orders = state.orders.filter((o) => !(ids.has(o.id) && o.deleted_at));
        return { deleted: before - state.orders.length };
      },
    },

    customers: {
      async upsert({ name, phone }) {
        const normalized = normalizePhone(phone);
        let customer = state.customers.find((c) => c.phone_normalized === normalized);
        if (!customer) {
          customer = { id: state.nextCustomerId++, name, phone, phone_normalized: normalized, created_at: nowIso(), addresses: [] };
          state.customers.push(customer);
        } else {
          customer.name = name;
        }
        return customer;
      },
      async update(customerId, { name, phone }) {
        const customer = state.customers.find((c) => c.id === customerId);
        if (!customer) throw new Error(`Customer #${customerId} not found.`);
        const nextName = (name ?? customer.name).trim();
        const nextPhone = (phone ?? customer.phone).trim();
        if (!nextName || !nextPhone) throw new Error('Name and phone number are both required.');
        const nextNormalized = normalizePhone(nextPhone);
        const dupe = state.customers.find((c) => c.phone_normalized === nextNormalized && c.id !== customerId);
        if (dupe) throw new Error(`Phone number ${nextPhone} already belongs to "${dupe.name}".`);
        customer.name = nextName;
        customer.phone = nextPhone;
        customer.phone_normalized = nextNormalized;
        return customer;
      },
      /**
       * Genuine hard delete (preview-mode twin of deleteCustomer() in
       * electron/database/repositories/customers.js): the customer
       * profile is gone for good, but their past orders are detached
       * (customer_id set to null) rather than removed, since every
       * order already carries its own customer_name/customer_phone/
       * customer_address snapshot from the time of sale.
       */
      async remove(customerId) {
        const idx = state.customers.findIndex((c) => c.id === customerId);
        if (idx === -1) throw new Error(`Customer #${customerId} not found.`);
        state.customers.splice(idx, 1);
        state.orders.forEach((o) => {
          if (o.customer_id === customerId) o.customer_id = null;
        });
        return true;
      },
      async listDuplicates() {
        const groups = new Map(); // normalized -> members[]
        state.customers.forEach((c) => {
          if (!c.phone_normalized) return;
          if (!groups.has(c.phone_normalized)) groups.set(c.phone_normalized, []);
          groups.get(c.phone_normalized).push({ id: c.id, name: c.name, phone: c.phone, created_at: c.created_at });
        });
        return [...groups.entries()]
          .filter(([, members]) => members.length > 1)
          .map(([phoneNormalized, members]) => ({ phoneNormalized, members }));
      },
      async addAddress(customerId, { label = null, address, isDefault = false }) {
        const customer = state.customers.find((c) => c.id === customerId);
        if (!customer) throw new Error(`Customer #${customerId} not found.`);
        if (isDefault) customer.addresses.forEach((a) => (a.is_default = 0));
        customer.addresses.push({ id: customer.addresses.length + 1, label, address, is_default: isDefault ? 1 : 0 });
        return customer;
      },
      async get(customerId) {
        return state.customers.find((c) => c.id === customerId) || null;
      },
      async getStats(customerId) {
        const orders = state.orders.filter((o) => o.customer_id === customerId && o.status === 'COMPLETED' && !o.deleted_at);
        const orderCount = orders.length;
        const totalSpent = +orders.reduce((sum, o) => sum + o.total, 0).toFixed(2);
        const sorted = orders.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));

        const itemMap = new Map(); // name -> { quantity, revenue }
        orders.forEach((o) => {
          o.items.forEach((line) => {
            const entry = itemMap.get(line.item_name_snapshot) || { name: line.item_name_snapshot, quantity: 0, revenue: 0 };
            entry.quantity += line.quantity;
            entry.revenue += line.total_price;
            itemMap.set(line.item_name_snapshot, entry);
          });
        });
        const topItems = [...itemMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

        const monthMap = new Map(); // 'YYYY-MM' -> total
        orders.forEach((o) => {
          const month = o.created_at.slice(0, 7);
          monthMap.set(month, (monthMap.get(month) || 0) + o.total);
        });
        const monthlySpend = [...monthMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-6)
          .map(([month, total]) => ({ month, total }));

        return {
          order_count: orderCount,
          total_spent: totalSpent,
          first_order_at: sorted[0]?.created_at || null,
          last_order_at: sorted[sorted.length - 1]?.created_at || null,
          topItems,
          monthlySpend,
        };
      },
      async list({ search = null, cursor = null, limit = 30, filter = 'all' } = {}) {
        let rows = state.customers;
        if (search) {
          const q = search.toLowerCase();
          const normalizedSearch = normalizePhone(search);
          rows = rows.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              c.phone.includes(q) ||
              (normalizedSearch && (c.phone_normalized || '').includes(normalizedSearch))
          );
        }
        rows = rows.map((c) => {
          const orders = state.orders.filter((o) => o.customer_id === c.id && o.status === 'COMPLETED' && !o.deleted_at);
          const sortedOrders = orders.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
          return {
            ...c,
            order_count: orders.length,
            total_spent: +orders.reduce((sum, o) => sum + o.total, 0).toFixed(2),
            last_order_at: sortedOrders.length ? sortedOrders[sortedOrders.length - 1].created_at : null,
          };
        });
        const inactiveCutoff = new Date(Date.now() - INACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        if (filter === 'regular') rows = rows.filter((c) => c.order_count >= REGULAR_MIN_ORDERS);
        if (filter === 'high_spender') rows = rows.filter((c) => c.total_spent >= HIGH_SPENDER_MIN_TOTAL);
        if (filter === 'new') rows = rows.filter((c) => c.created_at >= inactiveCutoff);
        if (filter === 'inactive') rows = rows.filter((c) => !c.last_order_at || c.last_order_at < inactiveCutoff);
        rows = rows.slice().sort((a, b) => b.id - a.id);
        if (cursor) rows = rows.filter((c) => c.id < cursor);
        const page = rows.slice(0, limit);
        return { rows: page, nextCursor: page.length === limit ? page[page.length - 1].id : null };
      },
    },

    security: {
      async isConfigured() { return state.securityConfig !== null; },
      async setLock({ lockType, credential, securityQuestion, securityAnswer }) {
        state.securityConfig = {
          lockType,
          credential: String(credential),
          securityQuestion: securityQuestion || null,
          securityAnswer: securityAnswer ? String(securityAnswer).trim().toLowerCase() : null,
        };
        return { lock_type: lockType };
      },
      async clearLock() {
        state.securityConfig = null;
        return true;
      },
      async verify(candidate) {
        if (!state.securityConfig) return false;
        return String(candidate) === state.securityConfig.credential;
      },
      async getQuestion() {
        return state.securityConfig?.securityQuestion || null;
      },
      async verifyAnswer(candidate) {
        if (!state.securityConfig?.securityAnswer) return false;
        return String(candidate).trim().toLowerCase() === state.securityConfig.securityAnswer;
      },
      async getLockType() {
        return state.securityConfig?.lockType || null;
      },
      // Fixed mock challenge/response pair (no real crypto needed here -
      // the real HMAC derivation is already independently verified in
      // electron/security/masterKeyRecovery.js). Preview mode just needs
      // something predictable to drive the UI against: the response is
      // always "MASTERKEY".
      async getRecoveryChallenge() {
        return 'PRVW-0000 (preview mode - key is "MASTERKEY")';
      },
      async verifyMasterKey(candidate) {
        const ok = String(candidate).trim().toUpperCase().replace(/[\s-]/g, '') === 'MASTERKEY';
        if (ok) state.securityConfig = null;
        return ok;
      },
    },

    settings: {
      async getAll() { return { ...state.settings }; },
      async set(entries) {
        Object.assign(state.settings, entries);
        return { ...state.settings };
      },
    },

    printer: {
      /**
       * No Electron main process to hand this to in preview mode, so
       * we open the same-shaped receipt in a new tab instead of
       * silently no-oping - lets us visually confirm receipt content
       * without a real printer or a full Electron launch.
       */
      async printReceipt(orderId) {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new Error(`Order #${orderId} not found - cannot print.`);
        const html = buildMockPreviewReceiptHtml(order, state.settings);
        const win = window.open('', '_blank', 'width=380,height=600');
        if (win) {
          win.document.write(html);
          win.document.close();
        }
        return { printed: true, deviceName: '(preview tab)' };
      },
      /**
       * Mirrors buildReceiptHtmlForOrder() in the real Electron main
       * process - returns the same receipt markup used above, just
       * without opening a tab, so the on-screen "View Receipt" modal
       * works identically in browser preview mode.
       */
      async getReceiptHtml(orderId) {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new Error(`Order #${orderId} not found - cannot print.`);
        return buildMockPreviewReceiptHtml(order, state.settings);
      },
      /**
       * No real OS to query in preview mode, so this returns a
       * plausible fake list - enough to test the Settings picker UI
       * (select one, save, etc.) without Electron.
       */
      async listPrinters() {
        return [
          { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: true },
          { name: 'POS-80 Series Printer (mock)', displayName: 'POS-80 Series Printer', isDefault: false },
        ];
      },
    },

    analytics: {
      async getSummary({ startDate, endDate }) {
        const start = new Date(startDate).getTime();
        const end = new Date(endDate).getTime();
        const inRange = state.orders.filter((o) => {
          if (o.status !== 'COMPLETED' || o.deleted_at) return false;
          const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
          return t >= start && t <= end;
        });

        const totalSales = inRange.reduce((s, o) => s + o.total, 0);
        const totalTax = inRange.reduce((s, o) => s + o.tax_amount, 0);
        const netSales = inRange.reduce((s, o) => s + o.subtotal, 0);

        const byDay = new Map();
        inRange.forEach((o) => {
          const day = o.created_at.slice(0, 10);
          byDay.set(day, (byDay.get(day) || 0) + o.total);
        });
        const dailyBreakdown = [...byDay.entries()]
          .map(([day, total]) => ({ day, total }))
          .sort((a, b) => a.day.localeCompare(b.day));

        const itemAgg = new Map();
        inRange.forEach((o) => {
          o.items.forEach((li) => {
            const cur = itemAgg.get(li.item_name_snapshot) || { name: li.item_name_snapshot, quantity: 0, revenue: 0 };
            cur.quantity += li.quantity;
            cur.revenue += li.total_price;
            itemAgg.set(li.item_name_snapshot, cur);
          });
        });
        const topItems = [...itemAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

        const typeAgg = new Map();
        inRange.forEach((o) => {
          const cur = typeAgg.get(o.order_type) || { order_type: o.order_type, count: 0, total: 0 };
          cur.count += 1;
          cur.total += o.total;
          typeAgg.set(o.order_type, cur);
        });

        return {
          totalSales,
          totalTax,
          netSales,
          orderCount: inRange.length,
          dailyBreakdown,
          topItems,
          orderTypeBreakdown: [...typeAgg.values()],
        };
      },
      /**
       * Reports tab of Hidden Records (preview-mode twin of
       * getDeletedSummary() in electron/database/repositories/analytics.js):
       * same shape as getSummary, aggregated over soft-deleted orders
       * instead of live ones. Omitting startDate/endDate covers every
       * deleted order, all time.
       */
      async getDeletedSummary({ startDate = null, endDate = null } = {}) {
        const start = startDate ? new Date(startDate).getTime() : -Infinity;
        const end = endDate ? new Date(endDate).getTime() : Infinity;
        const inRange = state.orders.filter((o) => {
          if (!o.deleted_at) return false;
          const t = new Date(o.created_at.replace(' ', 'T') + 'Z').getTime();
          return t >= start && t <= end;
        });

        const totalSales = inRange.reduce((s, o) => s + o.total, 0);
        const totalTax = inRange.reduce((s, o) => s + o.tax_amount, 0);
        const netSales = inRange.reduce((s, o) => s + o.subtotal, 0);

        const byDay = new Map();
        inRange.forEach((o) => {
          const day = o.created_at.slice(0, 10);
          byDay.set(day, (byDay.get(day) || 0) + o.total);
        });
        const dailyBreakdown = [...byDay.entries()]
          .map(([day, total]) => ({ day, total }))
          .sort((a, b) => a.day.localeCompare(b.day));

        const itemAgg = new Map();
        inRange.forEach((o) => {
          o.items.forEach((li) => {
            const cur = itemAgg.get(li.item_name_snapshot) || { name: li.item_name_snapshot, quantity: 0, revenue: 0 };
            cur.quantity += li.quantity;
            cur.revenue += li.total_price;
            itemAgg.set(li.item_name_snapshot, cur);
          });
        });
        const topItems = [...itemAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

        const typeAgg = new Map();
        inRange.forEach((o) => {
          const cur = typeAgg.get(o.order_type) || { order_type: o.order_type, count: 0, total: 0 };
          cur.count += 1;
          cur.total += o.total;
          typeAgg.set(o.order_type, cur);
        });

        return {
          totalSales,
          totalTax,
          netSales,
          orderCount: inRange.length,
          dailyBreakdown,
          topItems,
          orderTypeBreakdown: [...typeAgg.values()],
        };
      },
    },

    /**
     * Browser-preview stand-in only - never runs inside the packaged
     * Electron app, where window.pos (backed by
     * electron/whatsapp/whatsappService.js) is always used instead.
     *
     * This deliberately does NOT simulate a successful connection.
     * WhatsApp needs a real headless Chromium controlled from the main
     * process, which a plain browser tab cannot provide - an earlier
     * version of this mock faked a "Connected" status after a short
     * delay, which looked indistinguishable from a real working
     * connection and caused real confusion. Better to fail honestly.
     */
    whatsapp: (() => {
      let listeners = [];
      const notify = (payload) => listeners.forEach((fn) => fn(payload));
      const PREVIEW_MESSAGE = 'WhatsApp only works in the installed desktop app - this browser preview cannot connect for real.';
      const previewLogs = [];
      return {
        async init() {
          previewLogs.unshift({ time: new Date().toISOString(), message: PREVIEW_MESSAGE });
          notify({ type: 'status', status: 'AUTH_FAILURE', message: PREVIEW_MESSAGE });
          return { status: 'AUTH_FAILURE' };
        },
        async getStatus() {
          return { status: 'DISCONNECTED', qr: null, message: null, campaignActive: false };
        },
        async getLogs() {
          return previewLogs.slice();
        },
        async logout() {
          return true;
        },
        async getCampaignState() {
          return null; // preview mode never has a real send session
        },
        async startCampaign() {
          throw new Error(PREVIEW_MESSAGE);
        },
        async resumeCampaign() {
          throw new Error(PREVIEW_MESSAGE);
        },
        async retryFailed() {
          throw new Error(PREVIEW_MESSAGE);
        },
        async stopCampaign() {
          return true;
        },
        async newCampaign() {
          return true;
        },
        onEvent(callback) {
          listeners.push(callback);
          return () => {
            listeners = listeners.filter((fn) => fn !== callback);
          };
        },
        templates: {
          async list() {
            return state.whatsappTemplates.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          },
          async create({ name, message, imageDataUrl }) {
            const cleanName = String(name || '').trim();
            const cleanMessage = String(message || '').trim();
            if (!cleanName) throw new Error('Give this template a name (e.g. "Friday Deal").');
            if (!cleanMessage) throw new Error('The template message cannot be empty.');
            const template = {
              id: state.nextWhatsappTemplateId++,
              name: cleanName,
              message: cleanMessage,
              image_path: imageDataUrl || null, // preview-only: just keep the data URL itself
              created_at: nowIso(),
              updated_at: nowIso(),
            };
            state.whatsappTemplates.push(template);
            return template;
          },
          async update(id, { name, message, imageDataUrl, removeImage }) {
            const template = state.whatsappTemplates.find((t) => t.id === id);
            if (!template) throw new Error(`Template #${id} not found.`);
            if (name !== undefined) template.name = String(name).trim();
            if (message !== undefined) template.message = String(message).trim();
            if (imageDataUrl) template.image_path = imageDataUrl;
            if (removeImage) template.image_path = null;
            template.updated_at = nowIso();
            return template;
          },
          async remove(id) {
            state.whatsappTemplates = state.whatsappTemplates.filter((t) => t.id !== id);
            return true;
          },
        },
        // Preview-only stand-in: real image resolution needs Electron's
        // filesystem access. Template previews already carry their own
        // data URL directly in image_path, so nothing to resolve here.
        async getImage(relativePath) {
          return relativePath && relativePath.startsWith('data:') ? relativePath : null;
        },
      };
    })(),

    files: {
      getPathForFile(file) {
        return file?.name || null;
      },
    },
  };
}

if (!usingRealBridge) {
  console.warn('[posApi] window.pos not found - running with a full in-memory mock (browser preview mode).');
}

export const posApi = usingRealBridge ? window.pos : createMock();
export const isPreviewMode = !usingRealBridge;

// Mirror what preload.js does in real Electron (window.pos always
// exists) so devtools/test scripts can drive the mock the same way
// they'd drive the real bridge - e.g. window.pos.shifts.open(...).
if (!usingRealBridge && typeof window !== 'undefined') {
  window.pos = posApi;
}
