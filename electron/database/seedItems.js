'use strict';

const path = require('path');
const fs = require('fs');

/**
 * One-time starter menu. Seeded into the real items /
 * item_price_variants tables by calling itemsRepo.createItem() for
 * each entry - the exact same path a manually-added item goes
 * through (same SKU auto-generation, same validation, same
 * transaction handling). It only runs when the items table is
 * completely empty (a brand-new install), and only ever runs once.
 *
 * After that these are just ordinary rows: fully editable and
 * deletable from Menu Setup like anything else. Deleting a seeded
 * item removes it for good - it is never "restored" on the next
 * launch, because this function only acts on an EMPTY items table.
 */
function seedMenuIfEmpty(itemsRepo) {
  const existing = itemsRepo.listItems();
  if (existing.length > 0) return;

  const seedPath = path.join(__dirname, 'seedMenu.json');
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    console.error('[seed] could not read seedMenu.json - skipping starter menu.', err);
    return;
  }

  let added = 0;
  for (const entry of seed) {
    try {
      itemsRepo.createItem({
        name: entry.name,
        nameUrdu: entry.nameUrdu || null,
        category: entry.category,
        price: entry.price,
        description: entry.description || null,
        priceVariants: entry.priceVariants || [],
      });
      added += 1;
    } catch (err) {
      console.error(`[seed] failed to add starter item "${entry.name}" - skipping it.`, err);
    }
  }
  console.log(`[seed] added ${added} starter menu items to a fresh database.`);
}

/**
 * Fills in the Urdu name for any existing item that doesn't have one yet,
 * matching it (case-insensitively, by English name) against seedMenu.json.
 *
 * Covers databases that already had items in them before Urdu names were
 * added to the starter menu - seedMenuIfEmpty() only ever runs once on a
 * completely empty table, so those older rows would otherwise stay blank
 * forever. Runs on every launch; it's a no-op once everything is filled in.
 * Never touches an item that already has a name_urdu value.
 */
function backfillMissingUrduNames(itemsRepo) {
  const seedPath = path.join(__dirname, 'seedMenu.json');
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    return;
  }

  const urduByName = new Map();
  for (const entry of seed) {
    if (entry.nameUrdu && entry.name) {
      urduByName.set(String(entry.name).trim().toLowerCase(), entry.nameUrdu);
    }
  }
  if (urduByName.size === 0) return;

  const items = itemsRepo.listItems();
  let filled = 0;
  for (const item of items) {
    if (item.name_urdu && String(item.name_urdu).trim()) continue;
    const match = urduByName.get(String(item.name).trim().toLowerCase());
    if (!match) continue;
    try {
      itemsRepo.updateItem(item.id, { nameUrdu: match });
      filled += 1;
    } catch (err) {
      console.error(`[seed] failed to backfill Urdu name for "${item.name}".`, err);
    }
  }
  if (filled > 0) {
    console.log(`[seed] backfilled Urdu names for ${filled} existing item(s).`);
  }
}

module.exports = { seedMenuIfEmpty, backfillMissingUrduNames };
