#!/usr/bin/env node
'use strict';

/**
 * A customer forgot the PIN and chose "Developer recovery". Their screen shows a challenge like A1B2-C3D4.
 *
 *   npm run recovery:issue -- --challenge A1B2-C3D4
 *   (or with no arguments: it asks)
 *
 * You get a code starting with PR1. Send it to the customer; they paste it on the lock screen.
 * It works for that one PC, today (UTC) and until the end of tomorrow's first minute... no longer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ask, parseArgs } = require('./prompt');
const { loadPrivateKey } = require('./licenseTool');
const { PREFIX, recoveryMessage, normalizeChallenge } = require('../../electron/security/masterKeyRecovery');

const ROOT = path.join(__dirname, '..', '..');

/** @returns {string} the response code for a challenge */
function issuePinReset({ privateKey, challenge }) {
  const c = normalizeChallenge(challenge);
  if (!/^[0-9A-F]{8}$/.test(c)) throw new Error('The challenge must be 8 letters/numbers, like A1B2-C3D4.');
  return PREFIX + crypto.sign(null, recoveryMessage(c), privateKey).toString('base64url');
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const dir = path.resolve(args.dir || path.join(ROOT, 'license-keys'));
    const keyPath = args.key ? path.resolve(args.key) : (() => {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^recovery-private-.*\.pem$/.test(f)).sort() : [];
      return files.length ? path.join(dir, files[files.length - 1]) : null;
    })();
    if (!keyPath || !fs.existsSync(keyPath)) {
      console.error(`No recovery private key found in ${dir}.\nCreate it once with:  npm run recovery:keys`);
      process.exit(1);
    }
    const challenge = args.challenge && args.challenge !== true ? args.challenge : await ask('Challenge shown on the customer screen (e.g. A1B2-C3D4): ');
    const passphrase = process.env.LICENSE_PASSPHRASE || (await ask('Recovery key passphrase (not shown): ', { hidden: true }));
    let code;
    try {
      code = issuePinReset({ privateKey: loadPrivateKey(fs.readFileSync(keyPath, 'utf8'), passphrase), challenge });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'pin-resets.csv'), `"${new Date().toISOString()}","${normalizeChallenge(challenge)}"\n`);
    console.log(`\nSend this to the customer (valid for that PC, today only):\n\n${code}\n`);
  })();
}

module.exports = { issuePinReset };
