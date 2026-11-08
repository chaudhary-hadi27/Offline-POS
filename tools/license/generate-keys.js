#!/usr/bin/env node
'use strict';

/**
 * ONE-TIME: create your signing key pair.
 *
 *   node tools/license/generate-keys.js
 *
 *   private.pem  = your "muhr" (stamp). Encrypted with a passphrase you type.
 *                  Written to ./license-keys/ (git-ignored). MOVE IT to a USB
 *                  drive and keep a second copy elsewhere. NEVER commit it, never
 *                  put it in an installer. If you lose it (or the passphrase) you
 *                  can no longer issue licenses.
 *   public.pem   = the matching public key. This script also copies it into
 *                  electron/license/publicKeys.js, which IS shipped inside the app.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ask, parseArgs } = require('./prompt');

const ROOT = path.join(__dirname, '..', '..');
const KEYS_FILE = path.join(ROOT, 'electron', 'license', 'publicKeys.js');

function readExistingPublicKeys() {
  delete require.cache[require.resolve(KEYS_FILE)];
  return require(KEYS_FILE);
}

function writePublicKeysFile(keys, minEpoch) {
  const body = `'use strict';

/**
 * The vendor's PUBLIC key(s). This file is (re)written by
 *     node tools/license/generate-keys.js
 * Public keys are safe to ship - they can only CHECK a signature, never create one.
 *
 * Each key has a \`kid\` (key id) written into every license, so a new key can be
 * added later without invalidating licenses signed by an older one.
 *
 * MIN_LICENSE_EPOCH: licenses carry an \`epoch\` number. If a build ever leaks or is
 * cracked, raise this in the next release and issue new licenses with the higher
 * epoch - licenses from before stop working on the new build.
 */

const PUBLIC_KEYS = ${JSON.stringify(keys, null, 2)};

const MIN_LICENSE_EPOCH = ${minEpoch};

module.exports = { PUBLIC_KEYS, MIN_LICENSE_EPOCH };
`;
  fs.writeFileSync(KEYS_FILE, body, 'utf8');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir || path.join(ROOT, 'license-keys'));
  const existing = readExistingPublicKeys();
  // A key pair already exists: do not silently make another one. Adding a second key
  // (key rotation) must be a deliberate choice: pass --kid with a NEW id.
  if (existing.PUBLIC_KEYS.length > 0 && !args.kid) {
    const ids = existing.PUBLIC_KEYS.map((k) => k.kid).join(', ');
    console.error(`A signing key already exists (kid ${ids}) - nothing was created.
If you really want to ADD a second key (key rotation), run again with  --kid <a new id>.`);
    process.exit(1);
  }
  const kid = String(args.kid || 1);
  if (existing.PUBLIC_KEYS.some((k) => k.kid === kid)) {
    console.error(`A key with id "${kid}" already exists in publicKeys.js. Pass --kid <new id> to add another.`);
    process.exit(1);
  }
  const privatePath = path.join(dir, `private-${kid}.pem`);
  if (fs.existsSync(privatePath)) {
    console.error(`${privatePath} already exists - refusing to overwrite your private key.`);
    process.exit(1);
  }

  let passphrase = process.env.LICENSE_PASSPHRASE;
  if (!passphrase) {
    passphrase = await ask('Choose a LONG passphrase for the private key (it is not shown): ', { hidden: true });
    const again = await ask('Type it again: ', { hidden: true });
    if (passphrase !== again) {
      console.error('The two passphrases did not match. Nothing was created.');
      process.exit(1);
    }
  }
  if (passphrase.length < 12) {
    console.error('Use at least 12 characters (4-5 random words is easy to remember and hard to guess).');
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    privatePath,
    privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(dir, `public-${kid}.pem`), publicPem);
  writePublicKeysFile([...existing.PUBLIC_KEYS, { kid, pem: publicPem }], existing.MIN_LICENSE_EPOCH);

  console.log(`
Done.

  Private key (your stamp):  ${privatePath}
  Public key (goes in app):  electron/license/publicKeys.js   [kid ${kid}]

NEXT - do these now:
  1. Copy ${path.basename(privatePath)} to a USB drive AND to a second safe place.
  2. Write the passphrase on paper and keep it somewhere DIFFERENT from the key file.
  3. Test: open the copy with the passphrase (node tools/license/issue-license.js --help).
  4. Rebuild the app so it carries the public key (npm run dist:win).
  5. Never commit license-keys/ (it is in .gitignore) and never ship private-*.pem.
`);
})();
