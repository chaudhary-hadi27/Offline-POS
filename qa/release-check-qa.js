#!/usr/bin/env node
'use strict';

/**
 * QA for the release pre-flight (scripts/check-license-config.js) and the one-time key tools.
 * Everything runs in a TEMP COPY of the project, so your real files and keys are never touched.
 *   node qa/release-check-qa.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (name, cond, note = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${note}`}`);
  if (!cond) failed++;
};

function copyProject() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rel-'));
  const skip = new Set(['node_modules', '.git', 'dist', 'release', '.puppeteer-cache', 'seed-images']);
  (function cp(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) cp(s, d);
      else fs.copyFileSync(s, d);
    }
  })(ROOT, dest);
  return dest;
}
const run = (dir, script, args = [], env = {}) => spawnSync(process.execPath, [path.join(dir, script), ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
const check = (dir) => run(dir, 'scripts/check-license-config.js');
const edit = (dir, rel, fn) => {
  const p = path.join(dir, rel);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};

// ---- the one-time key tools (in the copy)
const base = copyProject();
const PASS = 'a long test passphrase 123';
const noRec = check(base);
ok('before the recovery key exists, the release check STOPS and says how to create it', noRec.status === 1 && /npm run recovery:keys/.test(noRec.stderr), noRec.stderr.slice(0, 300));
const gen = run(base, 'tools/license/generate-recovery-key.js', ['--dir', path.join(base, 'license-keys')], { LICENSE_PASSPHRASE: PASS });
ok('recovery:keys creates the private key file and puts the public key in the app', gen.status === 0 && fs.existsSync(path.join(base, 'license-keys/recovery-private-1.pem')) && /BEGIN PUBLIC KEY/.test(fs.readFileSync(path.join(base, 'electron/security/recoveryPublicKeys.js'), 'utf8')), gen.stderr);
const again = run(base, 'tools/license/generate-recovery-key.js', ['--dir', path.join(base, 'license-keys')], { LICENSE_PASSPHRASE: PASS });
ok('running it a second time refuses (your private key is never overwritten)', again.status === 1 && /already exists/.test(again.stderr), again.stderr);
const privText = fs.readFileSync(path.join(base, 'license-keys/recovery-private-1.pem'), 'utf8');
ok('the private key file is encrypted with the passphrase', /ENCRYPTED PRIVATE KEY/.test(privText));

// ---- the whole customer story: challenge on screen -> developer issues -> app accepts
delete require.cache[require.resolve(path.join(base, 'electron/security/masterKeyRecovery.js'))];
delete require.cache[require.resolve(path.join(base, 'electron/security/recoveryPublicKeys.js'))];
const rec = require(path.join(base, 'electron/security/masterKeyRecovery.js'));
const MID = 'AAAA-BBBB-CCCC-DDDD';
const ch = rec.generateChallenge(MID).challenge;
const issued = run(base, 'tools/license/issue-pin-reset.js', ['--challenge', ch, '--dir', path.join(base, 'license-keys')], { LICENSE_PASSPHRASE: PASS });
const codeLine = issued.stdout.split('\n').find((l) => l.startsWith('PR1.'));
ok('recovery:issue gives a PR1. code for the challenge', issued.status === 0 && !!codeLine, issued.stderr);
ok('the app (with the generated public key) accepts that code for that PC', rec.verifyMasterKey(MID, codeLine) === true);
ok('...but not on another PC', rec.verifyMasterKey('1111-2222-3333-4444', codeLine) === false);
const wrongPass = run(base, 'tools/license/issue-pin-reset.js', ['--challenge', ch, '--dir', path.join(base, 'license-keys')], { LICENSE_PASSPHRASE: 'wrong passphrase!!' });
ok('a wrong passphrase issues nothing', wrongPass.status === 1 && !/PR1\./.test(wrongPass.stdout), wrongPass.stderr);
const badCh = run(base, 'tools/license/issue-pin-reset.js', ['--challenge', 'XYZ', '--dir', path.join(base, 'license-keys')], { LICENSE_PASSPHRASE: PASS });
ok('a wrong challenge (typo) issues nothing', badCh.status === 1 && /8 letters/.test(badCh.stderr), badCh.stderr);
ok('every issued reset is logged on the developer PC', /"[0-9A-F]{8}"/.test(fs.readFileSync(path.join(base, 'license-keys/pin-resets.csv'), 'utf8')));

// ---- release check: baseline passes, then each mistake is caught
fs.rmSync(path.join(base, 'license-keys'), { recursive: true, force: true }); // the private key lives only on the dev PC, not in a project folder... keep it out of scans
const good = check(base);
ok('baseline (both public keys present, nothing wrong) passes', good.status === 0 && /Release check OK/.test(good.stdout), good.stderr);

const scenarios = [
  ['a private key file inside electron/ is caught', (d) => fs.writeFileSync(path.join(d, 'electron/private-1.pem'), 'x'), /private key file/],
  ['"BEGIN PRIVATE KEY" text inside shipped code is caught', (d) => fs.appendFileSync(path.join(d, 'electron/license/tiers.js'), '\n// -----BEGIN PRIVATE KEY-----\n'), /looks like a secret/],
  ['a leftover MASTER_SECRET in shipped code is caught', (d) => fs.appendFileSync(path.join(d, 'electron/license/tiers.js'), '\nconst MASTER_SECRET = "x";\n'), /looks like a secret/],
  ['dev bypass no longer excluded from the installer is caught', (d) => edit(d, 'package.json', (t) => t.replace('"!electron/license/devBypass.js",', '')), /devBypass/],
  ['main.js reading POS_LICENSE_DEV directly is caught', (d) => fs.appendFileSync(path.join(d, 'electron/main.js'), '\nconst x = process.env.POS_LICENSE_DEV;\n'), /POS_LICENSE_DEV/],
  ['self-test files no longer excluded are caught', (d) => edit(d, 'package.json', (t) => t.replace('"!electron/license/__*.js",', '')), /Self-test files/],
  ['a new page missing from the tier catalogue is caught', (d) => edit(d, 'src/shell/modules.js', (t) => t.replace(/\n    id: 'analytics'/, "\n    id: 'brand-new-page'")), /tiers\.js/],
  ['no licence public key is caught', (d) => edit(d, 'electron/license/publicKeys.js', (t) => t.replace(/const PUBLIC_KEYS = \[[\s\S]*?\];/, 'const PUBLIC_KEYS = [];')), /npm run license:keys/],
  ['no recovery public key is caught', (d) => edit(d, 'electron/security/recoveryPublicKeys.js', (t) => t.replace(/const RECOVERY_PUBLIC_KEYS = \[[\s\S]*?\];/, 'const RECOVERY_PUBLIC_KEYS = [];')), /npm run recovery:keys/],
  ['a damaged public key is caught', (d) => edit(d, 'electron/security/recoveryPublicKeys.js', (t) => t.replace(/BEGIN PUBLIC KEY-----\\n/, 'BEGIN PUBLIC KEY-----\\nZZZ')), /not a valid public key/],
  ['.gitignore without license-keys/ is caught', (d) => edit(d, '.gitignore', (t) => t.replace(/^license-keys\/?$/m, '')), /license-keys/],
];
for (const [name, mutate, rx] of scenarios) {
  const d = copyProject();
  fs.copyFileSync(path.join(base, 'electron/security/recoveryPublicKeys.js'), path.join(d, 'electron/security/recoveryPublicKeys.js'));
  mutate(d);
  const r = check(d);
  ok(name, r.status === 1 && rx.test(r.stderr), `${r.status} ${r.stderr.slice(0, 200)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// excluded-on-purpose and warn-only cases
{
  const d = copyProject();
  fs.copyFileSync(path.join(base, 'electron/security/recoveryPublicKeys.js'), path.join(d, 'electron/security/recoveryPublicKeys.js'));
  fs.writeFileSync(path.join(d, 'electron/security/master-secret.generated.js'), 'module.exports={MASTER_SECRET:"x"}');
  const r = check(d);
  ok('an old master-secret file lying on disk is NOT shipped (excluded) and does not stop the build', r.status === 0, r.stderr);
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = copyProject();
  fs.copyFileSync(path.join(base, 'electron/security/recoveryPublicKeys.js'), path.join(d, 'electron/security/recoveryPublicKeys.js'));
  edit(d, 'package.json', (t) => t.replace('"perMachine": true', '"perMachine": false'));
  const r = check(d);
  ok('a per-user installer only WARNS (the build is not stopped)', r.status === 0 && /perMachine/.test(r.stderr), r.stderr);
  fs.rmSync(d, { recursive: true, force: true });
}

fs.rmSync(base, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall release-check checks passed');
process.exit(failed ? 1 : 0);
