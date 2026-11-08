'use strict';

/**
 * Where the license and the "latest time this POS has ever seen" live.
 *
 * Everything is stored in SEVERAL places on purpose, so deleting one (or
 * uninstalling the app and wiping its data folder) neither loses the
 * license nor lets someone reset the clock guard:
 *
 *   license key   userData/license.key  +  a second copy outside userData
 *   clock memory  userData/license-state.json
 *                 + a second file outside userData
 *                 + (Windows) a registry value under HKCU\Software\RestaurantPOS
 *   ...and the manager also reads the newest order / backup time from data
 *   the customer cannot delete without destroying their own sales history.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** Folder outside userData that survives "delete the app's data folder". */
function defaultSecondaryDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'RestaurantPOS');
  }
  return path.join(os.homedir(), '.restaurant-pos');
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/** A JSON file store: read() -> object|null, write(object). Never throws. */
function createFileStore(file) {
  return {
    name: file,
    async read() {
      try {
        const obj = JSON.parse(await fsp.readFile(file, 'utf8'));
        return obj && typeof obj === 'object' ? obj : null;
      } catch {
        return null;
      }
    },
    async write(obj) {
      try {
        await atomicWrite(file, JSON.stringify(obj));
      } catch {
        // a read-only / locked location must never break the POS
      }
    },
  };
}

function run(file, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Windows only: HKCU\Software\RestaurantPOS  value "State" (base64 JSON). Best effort. */
function createRegistryStore() {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const key = 'HKCU\\Software\\RestaurantPOS';
  return {
    name: 'registry',
    async read() {
      try {
        const out = await run(reg, ['query', key, '/v', 'State']);
        const m = /State\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
        return m ? JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8')) : null;
      } catch {
        return null;
      }
    },
    async write(obj) {
      try {
        await run(reg, ['add', key, '/v', 'State', '/t', 'REG_SZ', '/d', Buffer.from(JSON.stringify(obj)).toString('base64'), '/f']);
      } catch {
        // ignore - the other copies still hold the value
      }
    },
  };
}

function createClockStores({ userDataDir, secondaryDir = defaultSecondaryDir() }) {
  const stores = [createFileStore(path.join(userDataDir, 'license-state.json')), createFileStore(path.join(secondaryDir, 'state.dat'))];
  if (process.platform === 'win32') stores.push(createRegistryStore());
  return stores;
}

/** The license key text, kept in two places and healed if one goes missing. */
function createLicenseFiles({ userDataDir, secondaryDir = defaultSecondaryDir() }) {
  const primary = path.join(userDataDir, 'license.key');
  const secondary = path.join(secondaryDir, 'license.key');
  const read = async (f) => {
    try {
      return (await fsp.readFile(f, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  };
  return {
    primary,
    secondary,
    async load() {
      const a = await read(primary);
      const b = await read(secondary);
      const text = a || b;
      if (text) {
        // heal whichever copy is missing
        if (!a) await atomicWrite(primary, text).catch(() => {});
        if (!b) await atomicWrite(secondary, text).catch(() => {});
      }
      return text;
    },
    async save(text) {
      await atomicWrite(primary, text);
      await atomicWrite(secondary, text).catch(() => {});
    },
  };
}

module.exports = { createClockStores, createLicenseFiles, createFileStore, defaultSecondaryDir };
