'use strict';

const crypto = require('crypto');
const { RECOVERY_PUBLIC_KEYS } = require('./recoveryPublicKeys');

/**
 * "Forgot PIN" recovery by the developer, with NO secret inside the app.
 *
 *  1. The lock screen shows an 8-character CHALLENGE (this PC's id + today's UTC date).
 *  2. The customer sends it to the developer (message or call).
 *  3. The developer signs it with the PRIVATE recovery key (tools/license/issue-pin-reset.js)
 *     and sends back a response code: "PR1." + a signature.
 *  4. The app checks the signature with the PUBLIC recovery key that ships inside it.
 *
 * Only the private key can make a valid response, and it never leaves the developer's PC.
 * A response works for one PC and one day (today or yesterday UTC, to cover midnight).
 * Anyone can read the public key out of the installed app; that gives them nothing.
 */

const PREFIX = 'PR1.';
const DOMAIN = 'pos-pin-reset-v1';

function dayString(date) {
  return date.toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function getChallengeCode(machineId, date = new Date()) {
  return crypto.createHash('sha256').update(`${machineId}:${dayString(date)}`).digest('hex').slice(0, 8).toUpperCase();
}

/** Drop the dashes/spaces a person may copy along with the code. */
function normalizeChallenge(code) {
  return String(code || '').replace(/[\s-]/g, '').toUpperCase();
}

function formatForDisplay(code) {
  return code.match(/.{1,4}/g).join('-'); // "A1B2-C3D4": easy to read out
}

function generateChallenge(machineId, date = new Date()) {
  const code = getChallengeCode(machineId, date);
  return { challenge: formatForDisplay(code), raw: code };
}

/** The exact bytes the developer signs. Domain-separated so no licence or repair signature can ever match. */
function recoveryMessage(challenge) {
  return Buffer.from(`${DOMAIN}|${normalizeChallenge(challenge)}`, 'utf8');
}

/** Strip whitespace and invisible characters a chat app may add; the code itself is case-sensitive. */
function cleanResponse(text) {
  return String(text || '').replace(/[\s\p{Cf}]+/gu, '');
}

function verifyMasterKey(machineId, candidate, { keys = RECOVERY_PUBLIC_KEYS, now = new Date() } = {}) {
  try {
    if (!Array.isArray(keys) || keys.length === 0) return false; // recovery is not configured: nothing can match
    const t = cleanResponse(candidate);
    if (!t.startsWith(PREFIX)) return false;
    const sig = Buffer.from(t.slice(PREFIX.length), 'base64url');
    if (sig.length !== 64) return false;
    const days = [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)]; // today and yesterday (UTC)
    for (const day of days) {
      const msg = recoveryMessage(getChallengeCode(machineId, day));
      for (const k of keys) {
        if (crypto.verify(null, msg, crypto.createPublicKey(k.pem), sig)) return true;
      }
    }
  } catch {
    // anything odd means "not valid"
  }
  return false;
}

module.exports = { PREFIX, DOMAIN, generateChallenge, verifyMasterKey, getChallengeCode, recoveryMessage, normalizeChallenge };
