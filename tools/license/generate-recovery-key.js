#!/usr/bin/env node
'use strict';

/**
 * ONE-TIME: create the key pair for "Forgot PIN" recovery.
 *
 *   npm run recovery:keys
 *
 *   recovery-private-1.pem  your private key (encrypted with a passphrase). Stays on YOUR PC, in
 *                           license-keys/ (git-ignored). Back it up like the licence key. Never ship it.
 *   electron/security/recoveryPublicKeys.js   the public key. It goes inside the app and can only CHECK codes.
 *
 * This is a different key pair from the licence keys on purpose.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ask, parseArgs } = require('./prompt');

const ROOT = path.join(__dirname, '..', '..');
const KEYS_FILE = path.join(ROOT, 'electron', 'security', 'recoveryPublicKeys.js');

function readExisting() {
  delete require.cache[require.resolve(KEYS_FILE)];
  return require(KEYS_FILE).RECOVERY_PUBLIC_KEYS;
}

function writeKeysFile(keys) {
  const body = `'use strict';

/**
 * The PUBLIC key(s) for "Forgot PIN" recovery. This file is written by
 *     npm run recovery:keys        (tools/license/generate-recovery-key.js)
 * A public key can only CHECK a recovery code, never create one, so it is safe to ship inside the app.
 * It is a different key pair from the licence keys on purpose: leaking one never affects the other.
 *
 * Empty = recovery by the developer is switched off in this build (the build check stops a release
 * without it). The owner can still unlock with the security question.
 */
const RECOVERY_PUBLIC_KEYS = ${JSON.stringify(keys, null, 2)};

module.exports = { RECOVERY_PUBLIC_KEYS };
`;
  fs.writeFileSync(KEYS_FILE, body, 'utf8');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir || path.join(ROOT, 'license-keys'));
  const existing = readExisting();
  if (existing.length > 0 && !args.kid) {
    console.error(`A recovery key already exists (kid ${existing.map((k) => k.kid).join(', ')}) - nothing was created.\nTo ADD a second one (rotation) run again with  --kid <a new id>.`);
    process.exit(1);
  }
  const kid = String(args.kid || 1);
  if (existing.some((k) => k.kid === kid)) {
    console.error(`A recovery key with id "${kid}" already exists. Pass --kid <new id>.`);
    process.exit(1);
  }
  const privatePath = path.join(dir, `recovery-private-${kid}.pem`);
  if (fs.existsSync(privatePath)) {
    console.error(`${privatePath} already exists - refusing to overwrite your private key.`);
    process.exit(1);
  }

  let passphrase = process.env.LICENSE_PASSPHRASE;
  if (!passphrase) {
    passphrase = await ask('Choose a LONG passphrase for the recovery key (not shown): ', { hidden: true });
    const again = await ask('Type it again: ', { hidden: true });
    if (passphrase !== again) {
      console.error('The passphrases did not match. Nothing was created.');
      process.exit(1);
    }
  }
  if (passphrase.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { mode: 0o600 });
  writeKeysFile([...existing, { kid, pem: publicPem }]);

  console.log(`\nDone.\n\n  Private key (stays with you): ${privatePath}\n  Public key (goes in app):     electron/security/recoveryPublicKeys.js   [kid ${kid}]\n\nNEXT:\n  1. Copy ${path.basename(privatePath)} to a USB drive AND a second safe place; keep the passphrase somewhere else.\n  2. Rebuild the app so it carries the public key (npm run dist:win).\n  3. When a customer forgets the PIN:  npm run recovery:issue -- --challenge A1B2-C3D4\n`);
})();
