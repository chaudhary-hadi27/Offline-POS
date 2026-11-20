'use strict';

/**
 * Release pre-flight. Runs automatically before `npm run dist:win` and STOPS the build when
 * something that would hurt a customer or leak a secret is wrong. Run it any time:
 *
 *   npm run license:check
 *
 * It lists the files the installer will contain (from package.json "build.files") and looks inside them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const problems = [];
const warnings = [];
const bad = (m) => problems.push(m);
const warn = (m) => warnings.push(m);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const pkg = JSON.parse(read('package.json'));
const build = pkg.build || {};

// ---- 1) licence public key
{
  let keys = [];
  try {
    keys = require(path.join(ROOT, 'electron/license/publicKeys.js')).PUBLIC_KEYS;
  } catch (e) {
    bad(`Cannot read electron/license/publicKeys.js (${e.message}).`);
  }
  if (!Array.isArray(keys) || keys.length === 0) bad('No licence public key. Run: npm run license:keys   (then keep license-keys/ safe).');
  for (const k of keys || []) {
    try {
      const pub = crypto.createPublicKey(k.pem);
      if (pub.asymmetricKeyType !== 'ed25519') bad(`Licence key ${k.kid} is not an Ed25519 key.`);
    } catch {
      bad(`Licence key ${k.kid} is not a valid public key.`);
    }
  }
}

// ---- 2) recovery public key (Forgot PIN)
{
  let keys = [];
  try {
    keys = require(path.join(ROOT, 'electron/security/recoveryPublicKeys.js')).RECOVERY_PUBLIC_KEYS;
  } catch (e) {
    bad(`Cannot read electron/security/recoveryPublicKeys.js (${e.message}).`);
  }
  if (!Array.isArray(keys) || keys.length === 0) bad('No recovery public key. Run: npm run recovery:keys   (without it nobody can reset a forgotten PIN).');
  for (const k of keys || []) {
    try {
      crypto.createPublicKey(k.pem);
    } catch {
      bad(`Recovery key ${k.kid} is not a valid public key.`);
    }
  }
}

// ---- 3) what the installer will contain
const patterns = build.files || [];
const toRegex = (g) =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$'
  );
const includeRx = patterns.filter((p) => !p.startsWith('!')).map(toRegex);
const excludeRx = patterns.filter((p) => p.startsWith('!')).map((p) => toRegex(p.slice(1)));
const packaged = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (['node_modules', '.git', 'release', 'qa', 'docs', 'tools', 'scripts', 'license-keys'].includes(e.name) && !dir.startsWith('electron')) continue;
    if (e.isDirectory()) walk(rel);
    else if (includeRx.some((r) => r.test(rel)) && !excludeRx.some((r) => r.test(rel))) packaged.push(rel);
  }
})('');

const SECRET_MARKERS = [/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/, /MASTER_SECRET/, /POS_MASTER_SECRET\s*=/];
for (const rel of packaged) {
  if (/(^|\/)(recovery-)?private[^/]*\.pem$/i.test(rel) || /license-keys\//.test(rel)) bad(`The installer would contain a private key file: ${rel}`);
  if (/master-secret/i.test(rel)) bad(`The installer would contain ${rel} (the old shared secret).`);
  const full = path.join(ROOT, rel);
  if (fs.statSync(full).size < 2 * 1024 * 1024 && /\.(js|json|html|css|txt|md|mjs)$/i.test(rel)) {
    const text = fs.readFileSync(full, 'utf8');
    for (const rx of SECRET_MARKERS) if (rx.test(text)) bad(`${rel} contains something that looks like a secret (${rx.source.slice(0, 40)}...).`);
  }
}
if (packaged.length === 0) warn('Could not list the packaged files (check build.files in package.json).');

// ---- 4) development bypass must not ship, and must not be reachable another way
if (!(build.files || []).includes('!electron/license/devBypass.js')) bad('package.json build.files must exclude "!electron/license/devBypass.js".');
if (packaged.includes('electron/license/devBypass.js')) bad('electron/license/devBypass.js would be inside the installer.');
if (/POS_LICENSE_DEV/.test(stripComments(read('electron/main.js')))) bad('electron/main.js reads POS_LICENSE_DEV directly; it must only go through license/devBypass.js.');
if (packaged.some((f) => /__(selftest|redteam)/.test(f))) bad('Self-test files would be inside the installer.');

// ---- 5) installer hardening
if (!(build.nsis && build.nsis.perMachine === true)) warn('nsis.perMachine is not true: the app would be installed where a normal user can edit it.');
if (!build.afterPack || !fs.existsSync(path.join(ROOT, build.afterPack))) warn('No afterPack fuses hook: the exe will not have run-as-node / NODE_OPTIONS switched off.');

// ---- 6) git hygiene
try {
  const ignore = read('.gitignore');
  if (!/^license-keys\/?$/m.test(ignore)) bad('.gitignore must contain "license-keys/".');
  const tracked = require('child_process').execSync('git ls-files', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 }).toString().split('\n');
  const leaked = tracked.filter((f) => /(^|\/)(recovery-)?private[^/]*\.pem$/i.test(f) || /master-secret\.generated/.test(f) || /^license-keys\//.test(f));
  if (leaked.length) bad(`Git tracks secret files: ${leaked.join(', ')}`);
} catch {
  // not a git checkout
}

// ---- 7) every page is classified in the tier catalogue (a new page must not be silently free or open)
try {
  const tiers = require(path.join(ROOT, 'electron/license/tiers.js'));
  const ids = [...read('src/shell/modules.js').matchAll(/\n    id: '([a-z-]+)'/g)].map((m) => m[1]).sort();
  const cat = tiers.PAGES.map((p) => p.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(cat)) bad(`Pages in the app (${ids.join(', ')}) and in electron/license/tiers.js (${cat.join(', ')}) differ. Add the new page to tiers.js.`);
} catch (e) {
  bad(`Could not check the tier catalogue: ${e.message}`);
}

const publicCount = (() => {
  try {
    return require(path.join(ROOT, 'electron/license/publicKeys.js')).PUBLIC_KEYS.length;
  } catch {
    return 0;
  }
})();

warnings.forEach((w) => console.warn(`  Warning: ${w}`));
if (problems.length) {
  console.error('\n' + '='.repeat(70));
  console.error('RELEASE CHECK FAILED - the build was stopped:\n');
  problems.forEach((p) => console.error(`  - ${p}`));
  console.error('\nSee docs/RELEASE_GUIDE.md.');
  console.error('='.repeat(70) + '\n');
  process.exit(1);
}
console.log(`Release check OK (${publicCount} licence key, recovery key present, ${packaged.length} files would be packaged, no private key or secret inside).`);
