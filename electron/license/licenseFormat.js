'use strict';

/**
 * License + repair-code text format, shared by the app (verify) and the
 * vendor tool in tools/license (sign). Only the vendor's PRIVATE key can
 * produce a valid signature; the app only ever holds public keys.
 *
 *   license key   POS1.<payload>.<signature>     (base64url, no spaces)
 *   repair code   POS1R.<payload>.<signature>
 *
 * payload (license): { v, kid, mid, plan, cust, iat, exp, epoch }   times in epoch SECONDS
 * payload (repair):  { v, kid, type:'repair', mid, now }
 *
 * The signature covers a domain tag + the exact payload bytes, so a license
 * can never be replayed as a repair code (or the other way round), and no
 * JSON canonicalisation is needed - we sign and verify the bytes as sent.
 */

const crypto = require('crypto');

const LICENSE_PREFIX = 'POS1.';
const REPAIR_PREFIX = 'POS1R.';
const LICENSE_DOMAIN = 'POS-LICENSE-V1\n';
const REPAIR_DOMAIN = 'POS-REPAIR-V1\n';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Strip every kind of whitespace (a key pasted from WhatsApp is often wrapped). */
function cleanKeyText(text) {
  return String(text || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
}

/** "a1b2-c3d4 ..." -> "A1B2C3D4..." so IDs compare regardless of dashes/case. */
function normalizeHardwareId(id) {
  return String(id || '').toUpperCase().replace(/[^A-F0-9]/g, '');
}

function formatHardwareId(hex) {
  return String(hex).toUpperCase().match(/.{1,4}/g).join('-');
}

function signPayload(prefix, domain, payloadObj, privateKey) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(domain, 'utf8'), payload]), privateKey);
  return `${prefix}${b64u(payload)}.${b64u(sig)}`;
}

/**
 * @param {string} text
 * @param {'license'|'repair'} kind
 * @param {{kid:string, pem:string}[]} publicKeys
 * @returns {{ok:true, payload:object} | {ok:false, reason:'malformed'|'unknown-key'|'bad-signature'}}
 */
function verifySigned(text, kind, publicKeys) {
  const prefix = kind === 'repair' ? REPAIR_PREFIX : LICENSE_PREFIX;
  const domain = kind === 'repair' ? REPAIR_DOMAIN : LICENSE_DOMAIN;
  const t = cleanKeyText(text);
  if (!t.startsWith(prefix)) return { ok: false, reason: 'malformed' };
  const parts = t.slice(prefix.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };

  let payloadBytes;
  let sig;
  let payload;
  try {
    payloadBytes = Buffer.from(parts[0], 'base64url');
    sig = Buffer.from(parts[1], 'base64url');
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };

  const keyEntry = (publicKeys || []).find((k) => k.kid === payload.kid);
  if (!keyEntry) return { ok: false, reason: 'unknown-key' };
  try {
    const pub = crypto.createPublicKey(keyEntry.pem);
    const good = crypto.verify(null, Buffer.concat([Buffer.from(domain, 'utf8'), payloadBytes]), pub, sig);
    return good ? { ok: true, payload } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

module.exports = {
  LICENSE_PREFIX,
  REPAIR_PREFIX,
  LICENSE_DOMAIN,
  REPAIR_DOMAIN,
  cleanKeyText,
  normalizeHardwareId,
  formatHardwareId,
  signPayload,
  verifySigned,
};
