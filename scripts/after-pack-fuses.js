'use strict';

/**
 * electron-builder "afterPack" hook: flips Electron "fuses" in the packaged exe so the licence
 * cannot be sidestepped with run-time tricks. Runs on Windows builds only.
 *
 *   RunAsNode                   OFF  - ELECTRON_RUN_AS_NODE=1 would turn the exe into a plain Node
 *                                       interpreter that runs any script
 *   NodeOptions env var         OFF  - NODE_OPTIONS=--require evil.js
 *   --inspect CLI flags         OFF  - attaching a debugger to the main process
 *   OnlyLoadAppFromAsar         ON   - the app must come from app.asar, not a loose folder
 *
 * Optional, OFF unless you opt in:
 *   POS_ASAR_INTEGRITY=1        ON   - the exe refuses to start if app.asar was edited.
 *                                       Needs an electron-builder that embeds the asar digest for
 *                                       Windows; TEST THE INSTALLED APP before shipping with it,
 *                                       because a build without the digest will not start at all.
 */

const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const integrity = process.env.POS_ASAR_INTEGRITY === '1';
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrity,
  });
  console.log(`[fuses] flipped for ${path.basename(exe)} (asar integrity: ${integrity ? 'ON' : 'off'})`);
};
