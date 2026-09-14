'use strict';

/**
 * Downloads the exact Chrome build WhatsApp (via Puppeteer) needs into a
 * project-local folder (.puppeteer-cache) instead of the default
 * per-user cache folder outside node_modules (normally something like
 * C:\Users\<you>\.cache\puppeteer on Windows).
 *
 * WHY THIS EXISTS
 * ----------------
 * Puppeteer downloads Chrome once, at `npm install` time, into that
 * per-user cache folder - never into node_modules, and never into the
 * built app. That's invisible during development because the app
 * always runs on the same machine that ran `npm install`. But once the
 * app is packaged into the Windows installer and handed to a client, it
 * runs on a machine that never ran `npm install` - so that cache folder
 * doesn't exist there, Puppeteer can't find Chrome, and "Connect
 * WhatsApp" fails every single time with a generic "Connection failed",
 * even though it works perfectly on the developer's own computer.
 *
 * Running this script before `npm run dist:win` puts Chrome in
 * .puppeteer-cache/ instead, which package.json's "build.extraResources"
 * then bundles straight into the installer - so the exact same Chrome
 * ships inside the .exe and is found at runtime (see electron/main.js
 * and electron/whatsapp/whatsappService.js, which point Puppeteer at
 * this same folder).
 *
 * Always downloads the Windows build (--platform win64), even when run
 * on a Mac/Linux dev machine, since "npm run dist:win" only ever
 * targets Windows (see package.json "build.win").
 */

const path = require('path');
const { execFileSync } = require('child_process');

const CACHE_DIR = path.join(__dirname, '..', '.puppeteer-cache');
const CLI_PATH = require.resolve('puppeteer/lib/cjs/puppeteer/node/cli.js');

console.log(`Downloading Chrome (Windows build) into ${CACHE_DIR} ...`);

execFileSync(
  process.execPath,
  [CLI_PATH, 'browsers', 'install', 'chrome', '--platform', 'win64'],
  {
    stdio: 'inherit',
    env: { ...process.env, PUPPETEER_CACHE_DIR: CACHE_DIR },
  }
);

console.log('Done. This folder will be bundled into the installer automatically.');
