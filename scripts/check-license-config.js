#!/usr/bin/env node
'use strict';

/**
 * Runs before `npm run dist:win` (see package.json "predist:win").
 * Stops you from building an installer that would be locked forever, or
 * that accidentally carries a private signing key.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];

// 1) a usable public key must be present
const { PUBLIC_KEYS } = require(path.join(ROOT, 'electron', 'license', 'publicKeys.js'));
if (!Array.isArray(PUBLIC_KEYS) || PUBLIC_KEYS.length === 0) {
  problems.push('electron/license/publicKeys.js has no public key. Run:  node tools/license/generate-keys.js');
} else {
  for (const k of PUBLIC_KEYS) {
    try {
      const key = crypto.createPublicKey(k.pem);
      if (key.asymmetricKeyType !== 'ed25519') problems.push(`public key "${k.kid}" is not an ed25519 key.`);
    } catch {
      problems.push(`public key "${k.kid}" in publicKeys.js is not a valid PEM public key.`);
    }
  }
}

// 2) no private key may sit in anything that gets packaged
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
for (const dir of ['electron', 'dist']) {
  for (const file of walk(path.join(ROOT, dir))) {
    if (/\.pem$/i.test(file)) problems.push(`${path.relative(ROOT, file)} is a .pem file inside a packaged folder.`);
    if (!/\.(js|json|html|css|txt|map)$/i.test(file)) continue;
    if (/BEGIN (ENCRYPTED |RSA |EC )?PRIVATE KEY/.test(fs.readFileSync(file, 'utf8'))) {
      problems.push(`${path.relative(ROOT, file)} contains a PRIVATE KEY. Remove it before building.`);
    }
  }
}

if (problems.length) {
  console.error('\nLicense configuration check FAILED:\n');
  problems.forEach((p) => console.error(`  - ${p}`));
  console.error('\nSee docs/LICENSING_GUIDE.md.\n');
  process.exit(1);
}
console.log(`License configuration OK (${PUBLIC_KEYS.length} public key${PUBLIC_KEYS.length === 1 ? '' : 's'}, no private key in the package).`);
