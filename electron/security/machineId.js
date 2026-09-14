'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cachedId = null;

/**
 * We deliberately do NOT try to read real hardware serials (disk
 * UUID, motherboard ID, etc.) - that requires shelling out to
 * platform-specific tools (wmic on Windows) that are fragile, slow,
 * sometimes blocked by group policy, and cannot be verified from this
 * Linux dev environment. A random UUID generated on first run and
 * persisted to disk is just as effective as a stable per-installation
 * fingerprint for recovery-key purposes, without any of that risk.
 */
function getOrCreateMachineId(userDataDir) {
  if (cachedId) return cachedId;

  const filePath = path.join(userDataDir, 'machine.id');
  try {
    cachedId = fs.readFileSync(filePath, 'utf8').trim();
    if (cachedId) return cachedId;
  } catch {
    // File doesn't exist yet - fall through to create it.
  }

  cachedId = crypto.randomUUID();
  fs.writeFileSync(filePath, cachedId, 'utf8');
  return cachedId;
}

module.exports = { getOrCreateMachineId };
