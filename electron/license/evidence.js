'use strict';

/**
 * "What is the latest moment this POS can prove it has seen?" - read from
 * data the customer can't delete without destroying their own sales history
 * or backups. Used by the license clock guard (licenseManager.js).
 */

const fs = require('fs');
const path = require('path');

/** Newest order timestamp (UTC text "YYYY-MM-DD HH:MM:SS") as epoch ms, or null. Includes hidden orders. */
function latestOrderMs(db) {
  const row = db.prepare('SELECT MAX(created_at) AS t FROM orders').get();
  if (!row || !row.t) return null;
  const ms = Date.parse(`${String(row.t).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Newest backup attempt/success time recorded by the backup manager, or null. */
function backupStateMs(userDataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataDir, 'backup-state.json'), 'utf8'));
    const times = [s.lastSuccessAt, s.lastAttemptAt].map((t) => Date.parse(t)).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

module.exports = { latestOrderMs, backupStateMs };
