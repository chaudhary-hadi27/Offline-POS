'use strict';

const { getDb } = require('../db');

/**
 * Everything the WhatsApp Deal Sender's "Save as Template" / "Load
 * Template" flow needs. This repo used to also own campaign
 * history (whatsapp_campaigns / whatsapp_campaign_recipients), but
 * that history is intentionally not stored in the database anymore -
 * see electron/whatsapp/campaignStore.js, which keeps it in memory
 * plus a single overwritten JSON snapshot instead.
 */

// =====================================================================
// Templates - "Save as Template" / "Load Template" in the Deal Message card
// =====================================================================

function listTemplates() {
  const db = getDb();
  return db.prepare('SELECT * FROM whatsapp_templates ORDER BY updated_at DESC').all();
}

function getTemplateById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id) || null;
}

function createTemplate({ name, message }) {
  const db = getDb();
  const cleanName = String(name || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanName) throw new Error('Give this template a name (e.g. "Friday Deal").');
  if (!cleanMessage) throw new Error('The template message cannot be empty.');
  const info = db
    .prepare('INSERT INTO whatsapp_templates (name, message) VALUES (?, ?)')
    .run(cleanName, cleanMessage);
  return getTemplateById(info.lastInsertRowid);
}

/** Partial update - only touches the fields actually passed in. */
function updateTemplate(id, { name, message } = {}) {
  const db = getDb();
  const existing = getTemplateById(id);
  if (!existing) throw new Error(`Template #${id} not found.`);
  const nextName = name !== undefined ? String(name).trim() : existing.name;
  const nextMessage = message !== undefined ? String(message).trim() : existing.message;
  if (!nextName) throw new Error('Give this template a name.');
  if (!nextMessage) throw new Error('The template message cannot be empty.');
  db.prepare("UPDATE whatsapp_templates SET name = ?, message = ?, updated_at = datetime('now') WHERE id = ?").run(
    nextName,
    nextMessage,
    id
  );
  return getTemplateById(id);
}

function setTemplateImage(id, imagePath) {
  const db = getDb();
  db.prepare("UPDATE whatsapp_templates SET image_path = ?, updated_at = datetime('now') WHERE id = ?").run(imagePath, id);
  return getTemplateById(id);
}

function deleteTemplate(id) {
  const db = getDb();
  db.prepare('DELETE FROM whatsapp_templates WHERE id = ?').run(id);
  return true;
}

module.exports = {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  setTemplateImage,
  deleteTemplate,
};
