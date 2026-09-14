'use strict';

const crypto = require('crypto');

/**
 * DESIGN
 * ------
 * The client is completely offline, so recovery cannot involve a
 * server round-trip. Instead:
 *
 *  1. The app shows an 8-character CHALLENGE code, derived from this
 *     machine's persisted fingerprint (machineId.js) + today's UTC
 *     date. It's the same code all day on this machine, and different
 *     tomorrow or on any other install.
 *  2. The client reads that challenge to the developer/vendor over
 *     the phone.
 *  3. The developer - who holds MASTER_SECRET, and ONLY the developer,
 *     never shipped in the app bundle in a real deployment - computes
 *     the matching response key (via scripts/compute-master-key.js)
 *     and reads it back.
 *  4. The app recomputes the same response locally and compares.
 *
 * No secret ever needs to leave the developer's machine, and the code
 * is single-day/single-machine so it can't be reused later or shared
 * between installs.
 *
 * WHERE THE SECRET ACTUALLY LIVES AT RUNTIME
 * -------------------------------------------
 * A packaged .exe on a customer's PC will NEVER have POS_MASTER_SECRET
 * set as a real environment variable - customers don't set env vars,
 * and Electron doesn't inherit a build machine's shell environment
 * into the finished installer. So this can't just read process.env at
 * runtime in production; it needs the secret literally compiled into
 * the app bundle at build time. That's what
 * electron/security/master-secret.generated.js is for:
 * `npm run dist:win` runs scripts/generate-master-secret-file.js
 * first, which reads POS_MASTER_SECRET from YOUR (the developer's)
 * shell environment and writes it as a plain exported string into
 * that generated file - which then ships inside the asar bundle.
 * See docs/MASTER_KEY_AND_BUILD_GUIDE.md for the full walkthrough.
 */

function getMasterSecret() {
  // 1) Preferred: the value baked in at build time by
  //    scripts/generate-master-secret-file.js - this is what actually
  //    ships to customers.
  try {
    // eslint-disable-next-line global-require
    const generated = require('./master-secret.generated');
    if (generated && typeof generated.MASTER_SECRET === 'string' && generated.MASTER_SECRET.trim().length >= 16) {
      return generated.MASTER_SECRET.trim();
    }
  } catch (err) {
    // File missing entirely (e.g. very first checkout) - fall through.
  }

  // 2) Dev convenience: an env var set in the current shell, so
  //    `npm start` during development can exercise this without
  //    running the build-time injector first.
  const fromEnv = process.env.POS_MASTER_SECRET;
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();

  console.warn(
    '[security] No real POS_MASTER_SECRET found (checked the generated ' +
      'file and the environment). Using an insecure development ' +
      'fallback - run scripts/generate-master-secret-file.js with a ' +
      'real secret before shipping a build to a customer.'
  );
  return 'dev-only-insecure-fallback-secret-do-not-ship';
}

function getChallengeCode(machineId) {
  const dateStr = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD - rotates daily
  return crypto
    .createHash('sha256')
    .update(`${machineId}:${dateStr}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

/** Strips the display formatting (dashes/spaces) a human might have
 *  copied along with the code, so it doesn't matter whether the
 *  dashed "A1B2-C3D4" or the bare "A1B2C3D4" form gets passed in here -
 *  both hash identically. Without this, reading the on-screen dashed
 *  challenge straight into this function would silently produce the
 *  wrong response key. */
function normalizeCode(code) {
  return String(code || '').replace(/[\s-]/g, '').toUpperCase();
}

function computeResponseKey(challengeCode) {
  return crypto
    .createHmac('sha256', getMasterSecret())
    .update(normalizeCode(challengeCode))
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
}

function formatForDisplay(code) {
  // Group into 4-character blocks (e.g. "A1B2-C3D4-E5") purely for
  // readability when reading the code aloud over the phone.
  return code.match(/.{1,4}/g).join('-');
}

function generateChallenge(machineId) {
  const code = getChallengeCode(machineId);
  return { challenge: formatForDisplay(code), raw: code };
}

function verifyMasterKey(machineId, candidateKey) {
  const challenge = getChallengeCode(machineId);
  const expected = computeResponseKey(challenge);
  const normalized = normalizeCode(candidateKey);
  return normalized === expected;
}

module.exports = { generateChallenge, verifyMasterKey, computeResponseKey, getChallengeCode };
