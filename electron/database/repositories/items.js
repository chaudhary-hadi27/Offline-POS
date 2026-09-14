'use strict';

const { getDb } = require('../db');

function attachVariants(db, item) {
  if (!item) return item;
  const priceVariants = db
    .prepare('SELECT id, label, price FROM item_price_variants WHERE item_id = ? ORDER BY sort_order, id')
    .all(item.id);
  return { ...item, priceVariants };
}

function listItems({ category = null, onlyAvailable = false } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM items WHERE 1 = 1';
  const params = {};

  if (category) {
    sql += ' AND category = @category';
    params.category = category;
  }
  if (onlyAvailable) {
    sql += ' AND is_available = 1';
  }
  sql += ' ORDER BY sort_order, name';

  return db.prepare(sql).all(params).map((item) => attachVariants(db, item));
}

/**
 * Persists a manual drag-and-drop order from the New Order screen.
 * `orderedIds` is the COMPLETE list of item ids in their final desired
 * order (not just the ones visible in the current category/search
 * filter) - the caller re-splices the dragged item into the full menu
 * array first, so a single sequential renumber here is always safe.
 */
function reorderItems(orderedIds) {
  const db = getDb();
  const update = db.prepare('UPDATE items SET sort_order = ? WHERE id = ?');
  const runTransaction = db.transaction((ids) => {
    ids.forEach((id, index) => update.run(index, id));
  });
  runTransaction(orderedIds.map((id) => Number(id)));
  return listItems({ onlyAvailable: false });
}

function listCategories() {
  const db = getDb();
  return db
    .prepare('SELECT DISTINCT category FROM items ORDER BY category')
    .all()
    .map((r) => r.category);
}

function getItemById(id) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return item ? attachVariants(db, item) : null;
}

/** Turns "Chicken Biryani" into a short, DB-safe fallback like "CHICKENB". */
function slugifySku(name) {
  const slug = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8);
  return slug || 'ITEM';
}

/**
 * Short code (SKU) is optional in the UI, but items.sku is still
 * NOT NULL UNIQUE at the DB level - this generates a safe, unique
 * fallback (from the item name) so leaving it blank never breaks
 * that constraint.
 */
function generateUniqueSku(db, name) {
  const base = slugifySku(name);
  const exists = (sku) => !!db.prepare('SELECT 1 FROM items WHERE sku = ?').get(sku);
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

function replacePriceVariants(db, itemId, priceVariants) {
  db.prepare('DELETE FROM item_price_variants WHERE item_id = ?').run(itemId);
  if (!priceVariants || priceVariants.length === 0) return;
  const insert = db.prepare(
    'INSERT INTO item_price_variants (item_id, label, price, sort_order) VALUES (@itemId, @label, @price, @sortOrder)'
  );
  priceVariants.forEach((v, i) => {
    insert.run({ itemId, label: String(v.label).trim(), price: Number(v.price), sortOrder: i });
  });
}

function nextSortOrder(db) {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM items').get();
  return row.maxOrder + 1;
}

/** Trims a submitted Urdu name to null-or-string, same treatment as description. */
function normalizeUrduName(nameUrdu) {
  return nameUrdu && String(nameUrdu).trim() ? String(nameUrdu).trim() : null;
}

function createItem({ sku, name, nameUrdu = null, category, price, description = null, isAvailable = true, imagePath = null, priceVariants = [] }) {
  const db = getDb();
  const finalSku = sku && String(sku).trim() ? String(sku).trim() : generateUniqueSku(db, name);
  const stmt = db.prepare(`
    INSERT INTO items (sku, name, name_urdu, category, price, description, is_available, image_path, sort_order)
    VALUES (@sku, @name, @nameUrdu, @category, @price, @description, @isAvailable, @imagePath, @sortOrder)
  `);

  const runTransaction = db.transaction(() => {
    const info = stmt.run({
      sku: finalSku,
      name,
      nameUrdu: normalizeUrduName(nameUrdu),
      category,
      price,
      description: description && String(description).trim() ? String(description).trim() : null,
      isAvailable: isAvailable ? 1 : 0,
      imagePath,
      sortOrder: nextSortOrder(db),
    });
    replacePriceVariants(db, info.lastInsertRowid, priceVariants);
    return info.lastInsertRowid;
  });

  try {
    const newId = runTransaction();
    return getItemById(newId);
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed: items.sku')) {
      throw new Error(`Short code "${finalSku}" is already used by another item.`);
    }
    throw err;
  }
}

function updateItem(id, { name, nameUrdu, category, price, description, imagePath, priceVariants }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!existing) throw new Error(`Item #${id} not found.`);

  const runTransaction = db.transaction(() => {
    db.prepare(`
      UPDATE items
      SET name = @name,
          name_urdu = @nameUrdu,
          category = @category,
          price = @price,
          description = @description,
          image_path = @imagePath,
          updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id,
      name: name ?? existing.name,
      nameUrdu: nameUrdu !== undefined ? normalizeUrduName(nameUrdu) : existing.name_urdu,
      category: category ?? existing.category,
      price: price ?? existing.price,
      description: description !== undefined ? (String(description).trim() ? String(description).trim() : null) : existing.description,
      imagePath: imagePath !== undefined ? imagePath : existing.image_path,
    });
    if (priceVariants !== undefined) {
      replacePriceVariants(db, id, priceVariants);
    }
  });
  runTransaction();

  return getItemById(id);
}

/** Sets (or clears, with null) just the image path - used after an image upload/removal without touching other fields. */
function setImage(id, imagePath) {
  const db = getDb();
  const info = db
    .prepare(`UPDATE items SET image_path = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(imagePath, id);
  if (info.changes === 0) throw new Error(`Item #${id} not found.`);
  return getItemById(id);
}

/** One-click "Out of Stock" toggle from the Menu Setup grid. */
function setAvailability(id, isAvailable) {
  const db = getDb();
  const info = db
    .prepare(`UPDATE items SET is_available = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(isAvailable ? 1 : 0, id);
  if (info.changes === 0) throw new Error(`Item #${id} not found.`);
  return getItemById(id);
}

/**
 * Genuine hard delete - always, even for an item that's been sold
 * before. order_items already snapshots item_name_snapshot,
 * item_name_urdu_snapshot and unit_price at time of sale (same
 * reasoning as customer_name/customer_phone on orders), so a past
 * receipt never actually needs item_id to keep printing correctly -
 * only Menu Setup's own edit screen ever reads it live. Detaching old
 * order_items rows first (instead of leaving the FK to block the
 * delete, which is what this used to do) means "Delete" always means
 * delete - "Out of Stock" (setAvailability) is offered in the UI as a
 * separate, non-destructive option, not a fallback this forces you into.
 * (item_price_variants rows still cascade-delete automatically via
 * ON DELETE CASCADE.)
 */
function deleteItem(id) {
  const db = getDb();
  const runTransaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(id);
    if (!existing) throw new Error(`Item #${id} not found.`);
    db.prepare('UPDATE order_items SET item_id = NULL WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  });
  runTransaction();
  return true;
}

/**
 * Renames a category label across every item that has it (categories
 * are just a free-text column on items, not a separate table) - used
 * by Menu Setup's "Manage Categories" > Rename.
 * @returns {{renamed: number, category: string}}
 */
function renameCategory(oldName, newName) {
  const db = getDb();
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from) throw new Error('Category not found.');
  if (!to) throw new Error('New category name cannot be empty.');
  const info = db
    .prepare(`UPDATE items SET category = @to, updated_at = datetime('now') WHERE category = @from`)
    .run({ to, from });
  return { renamed: info.changes, category: to };
}

/**
 * Deletes a category. Since "category" is just a text column, there's
 * nothing to drop except what to do with the items that had it:
 *   - mode 'move': reassign every item to @moveTo (Menu Setup also
 *     offers "Uncategorized" here as a plain string, same as any
 *     other category name - there's no NULL/no-category state at the
 *     schema level).
 *   - mode 'delete-items': hard-delete every item in the category,
 *     one at a time through the same deleteItem() a single manual
 *     delete uses - past order history is detached (item_id set to
 *     NULL, snapshot columns untouched), never left in the way.
 * @returns {{moved:number}|{deleted:number, blocked:number, blockedNames:string[]}}
 */
function deleteCategory(categoryName, { mode, moveTo } = {}) {
  const db = getDb();
  const category = String(categoryName || '').trim();
  if (!category) throw new Error('Category not found.');

  if (mode === 'move') {
    const target = String(moveTo || '').trim();
    if (!target) throw new Error('Choose a category to move these items to.');
    if (target === category) throw new Error('Choose a different category to move these items to.');
    const info = db
      .prepare(`UPDATE items SET category = @target, updated_at = datetime('now') WHERE category = @category`)
      .run({ target, category });
    return { moved: info.changes };
  }

  if (mode === 'delete-items') {
    const rows = db.prepare('SELECT id, name FROM items WHERE category = ?').all(category);
    let deleted = 0;
    const blockedNames = [];
    rows.forEach((row) => {
      try {
        deleteItem(row.id);
        deleted += 1;
      } catch (err) {
        blockedNames.push(row.name);
      }
    });
    return { deleted, blocked: blockedNames.length, blockedNames };
  }

  throw new Error('Unknown delete mode.');
}

module.exports = {
  listItems,
  listCategories,
  getItemById,
  createItem,
  updateItem,
  setAvailability,
  setImage,
  deleteItem,
  reorderItems,
  renameCategory,
  deleteCategory,
};
