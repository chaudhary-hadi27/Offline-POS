'use strict';

/**
 * A PC identity that does NOT change when the POS is uninstalled/reinstalled
 * or its data folder is deleted:
 *
 *   Windows  HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid  (set when
 *            Windows is installed; survives app removal; only a Windows
 *            reinstall changes it)
 *   Linux    /etc/machine-id                                    (dev machines)
 *   other    fallback to the per-install UUID file (weaker - reported as such)
 *
 * We deliberately do NOT use motherboard/CPU/disk serials: many PCs report
 * blank or placeholder values ("To Be Filled By O.E.M."), `wmic` (the usual
 * way to read them) is removed from recent Windows builds, and replacing a
 * disk or network card would wrongly lock a paying customer out.
 *
 * The raw GUID is never shown or stored: it is hashed with an app-specific
 * prefix into a short, shareable ID like  A1B2-C3D4-E5F6-7890.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { formatHardwareId } = require('./licenseFormat');
const { getOrCreateMachineId } = require('../security/machineId');

function parseMachineGuid(stdout) {
  const m = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout || '');
  return m ? m[1].trim() : null;
}

function hashToHardwareId(raw) {
  const hex = crypto
    .createHash('sha256')
    .update(`restaurant-pos-license-v1|${String(raw).trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return formatHardwareId(hex);
}

function runExecFile(file, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * @returns {Promise<{id:string, source:'machine-guid'|'machine-id'|'file'}>}
 */
async function getHardwareId({ userDataDir, platform = process.platform, run = runExecFile, readFile = fs.promises.readFile } = {}) {
  try {
    if (platform === 'win32') {
      const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
      const out = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
      const guid = parseMachineGuid(out);
      if (guid) return { id: hashToHardwareId(guid), source: 'machine-guid' };
    } else if (platform === 'linux') {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const raw = (await readFile(f, 'utf8')).trim();
          if (raw) return { id: hashToHardwareId(raw), source: 'machine-id' };
        } catch {
          // try the next location
        }
      }
    }
  } catch (err) {
    console.warn('[license] could not read the OS machine id, using the per-install id instead:', err.message);
  }
  return { id: hashToHardwareId(getOrCreateMachineId(userDataDir)), source: 'file' };
}

module.exports = { getHardwareId, parseMachineGuid, hashToHardwareId };
