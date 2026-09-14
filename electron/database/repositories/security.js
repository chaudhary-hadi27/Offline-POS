'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

/**
 * NOTE ON SCOPE: This file only covers Phase 1 plumbing - storing and
 * verifying the lock credential + the Layer 1 security question,
 * both as salted hashes. The Layer 2 "Developer Master Key" backdoor
 * (hardware-fingerprint + timestamp hash, verified against a secret
 * the developer holds offline) is Phase 4 scope and lives in its own
 * module so the recovery-key algorithm isn't mixed in with normal
 * credential storage.
 */

function hashSecret(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return { hash, salt };
}

function verifySecret(plain, salt, expectedHash) {
  const { hash } = hashSecret(plain, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM security_config WHERE id = 1').get() || null;
}

function isLockConfigured() {
  return getConfig() !== null;
}

/**
 * @param {'PIN'|'PASSWORD'|'PATTERN'} lockType
 * @param {string} credential  raw PIN digits, password string, or a
 *   serialized pattern like "1-5-9-8-7" (node indices in stroke order)
 */
function setLock({ lockType, credential, securityQuestion = null, securityAnswer = null }) {
  if (!['PIN', 'PASSWORD', 'PATTERN'].includes(lockType)) {
    throw new Error(`Invalid lock type: ${lockType}`);
  }
  const db = getDb();
  const { hash: credential_hash, salt: credential_salt } = hashSecret(credential);

  let security_answer_hash = null;
  let security_answer_salt = null;
  if (securityAnswer) {
    const normalized = String(securityAnswer).trim().toLowerCase();
    const hashed = hashSecret(normalized);
    security_answer_hash = hashed.hash;
    security_answer_salt = hashed.salt;
  }

  db.prepare(
    `INSERT INTO security_config
       (id, lock_type, credential_hash, credential_salt,
        security_question, security_answer_hash, security_answer_salt, updated_at)
     VALUES (1, @lock_type, @credential_hash, @credential_salt,
             @security_question, @security_answer_hash, @security_answer_salt, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       lock_type = excluded.lock_type,
       credential_hash = excluded.credential_hash,
       credential_salt = excluded.credential_salt,
       security_question = excluded.security_question,
       security_answer_hash = excluded.security_answer_hash,
       security_answer_salt = excluded.security_answer_salt,
       updated_at = datetime('now')`
  ).run({
    lock_type: lockType,
    credential_hash,
    credential_salt,
    security_question: securityQuestion,
    security_answer_hash,
    security_answer_salt,
  });

  return getConfig();
}

/** Removes the lock entirely (admin choosing to temporarily disable it). */
function clearLock() {
  const db = getDb();
  db.prepare('DELETE FROM security_config WHERE id = 1').run();
}

function verifyCredential(candidate) {
  const config = getConfig();
  if (!config) return false;
  return verifySecret(candidate, config.credential_salt, config.credential_hash);
}

function verifySecurityAnswer(candidateAnswer) {
  const config = getConfig();
  if (!config || !config.security_answer_hash) return false;
  const normalized = String(candidateAnswer).trim().toLowerCase();
  return verifySecret(normalized, config.security_answer_salt, config.security_answer_hash);
}

function getSecurityQuestion() {
  const config = getConfig();
  return config ? config.security_question : null;
}

/** Safe for the renderer: tells the gatekeeper which input UI to render (PIN pad, password field, or pattern grid) without ever exposing the hash/salt. */
function getLockType() {
  const config = getConfig();
  return config ? config.lock_type : null;
}

module.exports = {
  isLockConfigured,
  getConfig,
  setLock,
  clearLock,
  verifyCredential,
  verifySecurityAnswer,
  getSecurityQuestion,
  getLockType,
};
