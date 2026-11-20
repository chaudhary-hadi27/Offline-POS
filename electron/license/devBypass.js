'use strict';

/**
 * DEVELOPMENT-ONLY licence bypass.
 *
 * This file is deliberately EXCLUDED from the installer (see package.json
 * build.files: "!electron/license/devBypass.js"), so an installed build has no
 * bypass code at all. main.js loads it inside try/catch and treats "missing"
 * as "no bypass".
 *
 * Why not just `!app.isPackaged`? Electron decides isPackaged ONLY from the
 * executable's file name ("electron.exe" => not packaged), so copying the
 * installed exe to electron.exe would have switched it off. We therefore also
 * refuse whenever the app is running out of an .asar archive.
 */

function isDevBypassEnabled({ app, env = process.env }) {
  if (!app || app.isPackaged) return false;
  let appPath = '';
  try {
    appPath = String(app.getAppPath() || '');
  } catch {
    return false;
  }
  if (/\.asar([\\/]|$)/i.test(appPath)) return false; // running from an installed archive
  if (/[\\/]resources[\\/]app([\\/]|$)/i.test(appPath)) return false; // unpacked installed build
  return env.POS_LICENSE_DEV === '1';
}

module.exports = { isDevBypassEnabled };
