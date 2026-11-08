'use strict';

/**
 * Vendor-side license logic (used by issue-license.js and by the tests).
 * NOTHING in this folder is shipped to customers: package.json's build
 * "files" list only includes electron/, dist/ and package.json.
 */

const crypto = require('crypto');
const {
  LICENSE_PREFIX,
  REPAIR_PREFIX,
  LICENSE_DOMAIN,
  REPAIR_DOMAIN,
  signPayload,
  normalizeHardwareId,
  formatHardwareId,
} = require('../../electron/license/licenseFormat');

/** plan code -> how long it runs from the start date */
const PLANS = {
  M30: { label: '30-day trial', days: 30 },
  Y01: { label: '1 year', years: 1 },
  Y03: { label: '3 years', years: 3 },
  Y10: { label: '10 years', years: 10 },
  CUSTOM: { label: 'Custom term' },
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** "2026-11-30" -> UTC midnight Date. Throws on garbage. */
function parseYmd(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) throw new Error(`Date must look like 2027-03-31 (got "${text}").`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (ymd(d) !== `${m[1]}-${m[2]}-${m[3]}`) throw new Error(`"${text}" is not a real calendar date.`);
  return d;
}

const endOfDaySeconds = (d) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) / 1000);

function addYears(d, years) {
  const y = d.getUTCFullYear() + years;
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 29 Feb + 1 year -> 28 Feb
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}

/**
 * Expiry as epoch SECONDS (the last second of the expiry day, UTC).
 * @param {object} o
 * @param {'M30'|'Y01'|'Y03'|'Y10'|'CUSTOM'} o.plan
 * @param {Date} [o.from]       start day (default: today UTC). For a RENEWAL pass
 *                              the later of today and the current expiry day, so
 *                              unused days are not lost.
 * @param {string} [o.expires]  YYYY-MM-DD, required for CUSTOM
 */
function computeExpirySeconds({ plan, from = new Date(), expires }) {
  const spec = PLANS[plan];
  if (!spec) throw new Error(`Unknown plan "${plan}". Use one of: ${Object.keys(PLANS).join(', ')}.`);
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (plan === 'CUSTOM') {
    const d = parseYmd(expires);
    if (d.getTime() < start.getTime()) throw new Error('The expiry date is in the past.');
    return endOfDaySeconds(d);
  }
  if (spec.days) return endOfDaySeconds(new Date(start.getTime() + spec.days * 86400000));
  return endOfDaySeconds(addYears(start, spec.years));
}

function toHardwareId(input) {
  const n = normalizeHardwareId(input);
  if (n.length !== 16) throw new Error('Hardware ID should look like A1B2-C3D4-E5F6-7890 (16 letters/numbers).');
  return formatHardwareId(n);
}

function loadPrivateKey(pemText, passphrase) {
  try {
    return crypto.createPrivateKey({ key: pemText, passphrase });
  } catch (err) {
    throw new Error('Could not open the private key - wrong passphrase, or the file is damaged.');
  }
}

/** @returns {{key:string, payload:object}} */
function issueLicense({ privateKey, kid = '1', hardwareId, customer, plan, from, expires, epoch = 1, now = new Date() }) {
  if (!customer || !String(customer).trim()) throw new Error('Customer / restaurant name is required.');
  const payload = {
    v: 1,
    kid: String(kid),
    mid: toHardwareId(hardwareId),
    plan,
    cust: String(customer).trim(),
    iat: Math.floor(now.getTime() / 1000),
    exp: computeExpirySeconds({ plan, from: from || now, expires }),
    epoch,
  };
  return { key: signPayload(LICENSE_PREFIX, LICENSE_DOMAIN, payload, privateKey), payload };
}

/** A clock-repair code carrying the vendor's real "now". See licenseManager.js. */
function issueRepair({ privateKey, kid = '1', hardwareId, now = new Date() }) {
  const payload = { v: 1, kid: String(kid), type: 'repair', mid: toHardwareId(hardwareId), now: Math.floor(now.getTime() / 1000) };
  return { key: signPayload(REPAIR_PREFIX, REPAIR_DOMAIN, payload, privateKey), payload };
}

/**
 * Looks in issued-licenses.csv for the newest LICENSE issued to this Hardware ID and
 * returns its expiry as "YYYY-MM-DD" (or null). Used by `--renew` so you never have to
 * remember when a customer's current license ends.
 */
function readLastExpiry(csvText, hardwareId) {
  const wanted = normalizeHardwareId(hardwareId);
  let found = null;
  for (const line of String(csvText || '').split('\n').slice(1)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    // issued_at,type,customer,hardware_id,plan,expires,kid,key
    if (cells.length < 6 || cells[1] !== 'license') continue;
    if (normalizeHardwareId(cells[3]) !== wanted || !cells[5]) continue;
    if (!found || cells[0] >= found.issuedAt) found = { issuedAt: cells[0], expires: cells[5] };
  }
  return found ? found.expires : null;
}

module.exports = { readLastExpiry, PLANS, computeExpirySeconds, issueLicense, issueRepair, loadPrivateKey, toHardwareId, parseYmd, ymd };
