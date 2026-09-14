'use strict';

const { getDb } = require('../db');

function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Bulk update from the Settings screen form (title, tax rate, printer port, etc). */
function setSettings(entries) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const runTransaction = db.transaction((pairs) => {
    for (const [key, value] of Object.entries(pairs)) {
      stmt.run({ key, value: String(value) });
    }
  });
  runTransaction(entries);
  return getAllSettings();
}

module.exports = { getAllSettings, getSetting, setSettings };
