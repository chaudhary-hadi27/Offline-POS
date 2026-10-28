'use strict';

/**
 * Automatic offline backup + restore.
 *
 * DESIGN (why it looks the way it does)
 * -------------------------------------
 * 1. Nobody has to remember anything. The manager backs up when the POS
 *    starts (after a short delay, so startup stays fast) and re-checks
 *    every hour for PCs that stay on for days. A backup only runs when
 *    the last good one is older than MIN_INTERVAL_HOURS.
 *
 * 2. The database is NEVER copied as a file. A live WAL-mode database
 *    isn't fully described by pos.sqlite alone (committed data can still
 *    sit in pos.sqlite-wal), so the snapshot is taken with SQLite's
 *    online backup API (better-sqlite3 db.backup()), which is safe while
 *    the POS keeps taking orders. The snapshot is then switched to a
 *    single-file journal mode and VERIFIED (integrity_check +
 *    foreign_key_check + row counts) before it is allowed anywhere near
 *    a backup folder. A snapshot that fails verification is thrown away
 *    and never replaces or prunes anything.
 *
 * 3. Two destinations, written independently, so one failing never
 *    blocks the other:
 *      - "local"    <Documents>/POS-Backups   (always on, zero setup)
 *      - "external" <chosen folder>/POS-Backups (USB / second drive /
 *                    another PC's shared folder; chosen once)
 *    Local alone protects against a corrupted/deleted database. Only an
 *    external copy survives the PC's disk dying - the UI says so.
 *
 * 4. Layout inside each POS-Backups folder (a README.txt there explains it
 *    to humans):
 *        db/POS-DB_2026-10-26_090500.sqlite.gz  one verified, compressed snapshot
 *        db/POS-DB_2026-10-26_090500.json       its manifest (counts, hash, source)
 *        files/item-images/...                 incremental IMAGE MIRROR
 *        files/custom-gallery/...
 *        files/deal-images/...
 *    Snapshots are versioned (never overwritten). Images are small,
 *    rarely change and are mirrored incrementally (only new/changed
 *    files are copied), so a backup of a 5,000-order restaurant stays
 *    quick. The mirror never deletes, so it is always a superset of what
 *    any retained snapshot references.
 *
 *    SCALE (measured with a simulated 5 years x 300 orders/day = 547k
 *    orders): the database is ~240-280 MB, db.backup() takes ~0.8s, gzip
 *    (level 3: about twice as fast as level 6 for ~10% bigger output)
 *    shrinks it to roughly 12-18% (30-45 MB), and integrity_check takes
 *    ~2s - which is why verification runs on a worker thread and snapshots
 *    are gzipped with streams, so the POS window keeps responding. The number of
 *    snapshot files does NOT grow with the years: retention keeps a fixed
 *    set (last 48h hourly, 7 days, 4 weeks, 3 months) and a size budget
 *    trims the oldest if the database ever gets huge.
 *
 * 5. What is NOT backed up: the bundled seed-images gallery (it ships
 *    inside the installer, so a reinstall brings it back). NOTE: an item
 *    never points at the bundled gallery - choosing a gallery picture
 *    copies it into item-images/item-<id>.jpg - so item-images IS backed
 *    up, and it has to be.
 *
 * 6. Backup STATE (last run, external folder) lives in backup-state.json
 *    next to the database, NOT inside it: restoring an old database must
 *    not rewind or overwrite the backup settings.
 *
 * 7. Restore never touches anything until the chosen snapshot has been
 *    verified, always takes a safety copy of the current database first,
 *    and swaps the database file in with a temp-file + rename.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');

const BACKUP_FOLDER_NAME = 'POS-Backups';
const FILE_DIRS = ['item-images', 'custom-gallery', 'deal-images'];
const SNAPSHOT_RE = /^POS-DB_(\d{4})-(\d{2})-(\d{2})_(\d{6})\.sqlite(\.gz)?$/;
const MIN_INTERVAL_HOURS = 12;
const WARN_AFTER_HOURS = 48;
const KEEP_DAYS = 7;
const KEEP_WEEKS = 4;
const KEEP_MONTHS = 3;
const KEEP_PRE_RESTORE = 3;
const KEEP_AT_LEAST = 3; // the size budget never trims below this many newest snapshots
const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024; // per destination

// ---------------------------------------------------------------- helpers

const pad = (n) => String(n).padStart(2, '0');

function stampFor(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The STORED name of a snapshot (gzipped). */
function snapshotNameFor(date) {
  return `POS-DB_${stampFor(date)}.sqlite.gz`;
}

function manifestNameFor(snapshotName) {
  return snapshotName.replace(/\.sqlite(\.gz)?$/, '.json');
}

/** "POS-DB_2026-10-26_090500.sqlite" -> local Date, or null. */
function dateFromSnapshotName(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, hms] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)));
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

/** Copy via a temp name + rename, so a half-written file can never look like a good one. */
async function atomicCopy(src, dest) {
  const tmp = `${dest}.tmp`;
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}

async function atomicWrite(dest, text) {
  const tmp = `${dest}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, dest);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 3 }), fs.createWriteStream(dest));
}

async function gunzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function sameDriveRoot(a, b) {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
}

// ------------------------------------------------------- snapshot checking

/**
 * Opens a snapshot read-only and proves it is a usable POS database.
 * Never throws for a bad database - returns { ok:false, errors:[...] }.
 */
function inspectSnapshot(file) {
  const errors = [];
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') errors.push(`integrity_check: ${integrity}`);
    const fk = db.pragma('foreign_key_check');
    if (fk.length > 0) errors.push(`foreign_key_check: ${fk.length} broken reference(s)`);

    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ['orders', 'order_items', 'items', 'customers', 'app_settings']) {
      if (!tables.has(t)) errors.push(`missing table: ${t}`);
    }
    const count = (t) => (tables.has(t) ? db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c : 0);
    return { ok: errors.length === 0, errors, orders: count('orders'), items: count('items'), customers: count('customers') };
  } catch (err) {
    return { ok: false, errors: [err.message], orders: 0, items: 0, customers: 0 };
  } finally {
    if (db) db.close();
  }
}

/**
 * inspectSnapshot() on a worker thread (so a multi-second integrity_check
 * can't freeze the POS). If a worker can't be started for any reason
 * (e.g. an unusual packaging setup) it falls back to checking in-thread:
 * slower for the UI, but never skipped.
 */
function inspectSnapshotAsync(file) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const w = new Worker(path.join(__dirname, 'inspectWorker.js'), { workerData: { file } });
      w.once('message', done);
      w.once('error', () => done(inspectSnapshot(file)));
      w.once('exit', () => done(inspectSnapshot(file)));
    } catch {
      done(inspectSnapshot(file));
    }
  });
}

// ---------------------------------------------------------- image mirroring

async function walkFiles(dir, rel = '') {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, r)));
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(r);
  }
  return out;
}

/** Copy new/changed files from `fromRoot/<dir>` to `toRoot/<dir>` for every image folder. */
async function mirrorFolders(fromRoot, toRoot) {
  let copied = 0;
  for (const dir of FILE_DIRS) {
    const src = path.join(fromRoot, dir);
    if (!(await exists(src))) continue;
    const dst = path.join(toRoot, dir);
    for (const rel of await walkFiles(src)) {
      const s = path.join(src, rel);
      const d = path.join(dst, rel);
      const sStat = await fsp.stat(s);
      let need = true;
      try {
        const dStat = await fsp.stat(d);
        need = dStat.size !== sStat.size || Math.abs(dStat.mtimeMs - sStat.mtimeMs) > 2000;
      } catch {
        need = true;
      }
      if (!need) continue;
      await ensureDir(path.dirname(d));
      await atomicCopy(s, d);
      await fsp.utimes(d, sStat.atime, sStat.mtime);
      copied += 1;
    }
  }
  return copied;
}

// -------------------------------------------------------------- retention

function weekKey(d) {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/**
 * Which snapshot file names to KEEP: the newest one of every HOUR in the
 * last 48 hours (so a mistake noticed the same day can still be undone
 * from an earlier snapshot, but pressing "Back up now" five times in a
 * row doesn't leave five files), then the newest one of each of the last KEEP_DAYS days,
 * KEEP_WEEKS weeks and KEEP_MONTHS months that have backups. The single
 * newest snapshot is always kept.
 * @param {string[]} names snapshot file names
 * @param {Date} [now]
 */
function chooseSnapshotsToKeep(names, now = new Date()) {
  const dated = names
    .map((name) => ({ name, date: dateFromSnapshotName(name) }))
    .filter((x) => x.date)
    .sort((a, b) => b.date - a.date); // newest first
  const keep = new Set();
  if (dated.length) keep.add(dated[0].name);
  const hoursSeen = new Set();
  for (const x of dated) {
    if (now - x.date > 48 * 3600000) continue;
    const hk = `${x.date.getFullYear()}-${x.date.getMonth()}-${x.date.getDate()}-${x.date.getHours()}`;
    if (hoursSeen.has(hk)) continue;
    hoursSeen.add(hk);
    keep.add(x.name);
  }
  const take = (keyFn, limit) => {
    const seen = new Set();
    for (const x of dated) {
      const k = keyFn(x.date);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(x.name);
    }
  };
  take((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, KEEP_DAYS);
  take(weekKey, KEEP_WEEKS);
  take((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, KEEP_MONTHS);
  return keep;
}

async function readManifest(dbDir, name) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dbDir, manifestNameFor(name)), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Deletes snapshots that fall outside the retention rules - but ONLY ones
 * written by this install (same sourceId; snapshots with no sourceId are
 * treated as ours). Snapshots another PC made into the same folder (e.g.
 * you plugged in the old PC's USB drive) are never touched.
 * After the retention rules, a size budget trims the oldest kept ones
 * (never below the KEEP_AT_LEAST newest).
 */
async function pruneDestination(root, now, ownSourceId, maxBytes = MAX_TOTAL_BYTES) {
  const dbDir = path.join(root, 'db');
  const all = (await fsp.readdir(dbDir)).filter((n) => SNAPSHOT_RE.test(n));
  const ours = [];
  for (const n of all) {
    const m = await readManifest(dbDir, n);
    if (!m || !m.sourceId || m.sourceId === ownSourceId) ours.push({ name: n, size: m?.sizeBytes ?? null });
  }
  const keep = chooseSnapshotsToKeep(ours.map((x) => x.name), now);

  // size budget (newest first; keep at least KEEP_AT_LEAST)
  const kept = ours.filter((x) => keep.has(x.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const x of kept) {
    if (x.size == null) x.size = (await fsp.stat(path.join(dbDir, x.name)).catch(() => ({ size: 0 }))).size;
  }
  let total = kept.reduce((sum, x) => sum + x.size, 0);
  for (let i = kept.length - 1; i >= KEEP_AT_LEAST && total > maxBytes; i--) {
    keep.delete(kept[i].name);
    total -= kept[i].size;
  }

  let removed = 0;
  for (const x of ours) {
    if (keep.has(x.name)) continue;
    await fsp.rm(path.join(dbDir, x.name), { force: true });
    await fsp.rm(path.join(dbDir, manifestNameFor(x.name)), { force: true });
    removed += 1;
  }
  return removed;
}

const README_TEXT = `POS BACKUPS - what is in this folder
====================================

This folder is written automatically by the Restaurant POS. Nobody needs to
do anything. You can leave it alone.

  db\\      One file per backup:  POS-DB_<date>_<time>.sqlite.gz
             (your whole database, compressed) and a small .json file next
             to it that describes it (date, number of orders, checksum).
             Old backups are deleted automatically; only the useful ones
             are kept (hourly for 2 days, then daily / weekly / monthly).
  files\\   Copies of your pictures (menu photos, gallery, deal images).
             New pictures are added here automatically.

MOVING TO A NEW PC / RESTORING
  1. Install the POS on the new PC and open it.
  2. Copy this whole "POS-Backups" folder onto the new PC (or plug in the USB
     drive it is on).
  3. Settings (bottom of the page) -> Backup & Restore -> "Choose folder"
     and pick the folder that CONTAINS "POS-Backups".
  4. Open "External drive / folder" under Saved backups, press Restore on the
     newest backup. The POS restarts with all your data.
  Then re-select the printer in Settings -> Printer and, if you use WhatsApp
  deals, scan the WhatsApp QR code again.

Do not rename or edit the files in here.
`;

async function ensureReadme(root) {
  const f = path.join(root, 'README.txt');
  if (!(await exists(f))) await atomicWrite(f, README_TEXT);
}

// ---------------------------------------------------------------- listing

async function listSnapshots(root) {
  const dbDir = path.join(root, 'db');
  if (!(await exists(dbDir))) return [];
  const rows = [];
  for (const name of await fsp.readdir(dbDir)) {
    if (!SNAPSHOT_RE.test(name)) continue;
    const file = path.join(dbDir, name);
    let manifest = null;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dbDir, manifestNameFor(name)), 'utf8'));
    } catch {
      manifest = null;
    }
    let size = manifest?.sizeBytes;
    if (size == null) {
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        continue;
      }
    }
    rows.push({
      name,
      createdAt: manifest?.createdAt || dateFromSnapshotName(name).toISOString(),
      orders: manifest?.orders ?? null,
      items: manifest?.items ?? null,
      customers: manifest?.customers ?? null,
      sizeBytes: size,
      appVersion: manifest?.appVersion ?? null,
    });
  }
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}

// ---------------------------------------------------------------- manager

/**
 * @param {object} o
 * @param {() => import('better-sqlite3').Database} o.getDb          live DB handle
 * @param {string} o.userDataDir
 * @param {string} o.defaultLocalDir   parent of the local POS-Backups folder
 * @param {string} o.appVersion
 * @param {() => void}  [o.closeDb]    used only by restore()
 * @param {() => void}  [o.reopenDb]   used only by restore()
 * @param {(msg:string, err?:any)=>void} [o.log]
 * @param {() => Date} [o.now]
 * @param {number} [o.maxTotalBytes]  per-destination size budget (default 3 GB)
 */
function createBackupManager(o) {
  const log = o.log || (() => {});
  const now = o.now || (() => new Date());
  const statePath = path.join(o.userDataDir, 'backup-state.json');
  const stagingDir = path.join(o.userDataDir, 'backup-staging');
  const preRestoreDir = path.join(o.userDataDir, 'pre-restore');
  const startedAt = now();
  let running = false;
  let timers = [];

  // ---- state file (outside the database on purpose) ----
  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return { externalDir: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, destinations: {}, ...s };
    } catch {
      return { externalDir: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, destinations: {} };
    }
  }
  function writeState(state) {
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
  }
  // Identifies THIS install's backups. Pruning only ever deletes snapshots
  // carrying this id, so another PC's backups sitting in the same USB folder
  // are never touched (and a restore adopts the restored backup's id, so the
  // "same restaurant" lineage carries on after moving to a new PC).
  {
    const st = readState();
    if (!st.installId) {
      st.installId = crypto.randomUUID();
      writeState(st);
    }
  }

  function destinations(state = readState()) {
    const list = [{ id: 'local', label: 'This PC', root: path.join(o.defaultLocalDir, BACKUP_FOLDER_NAME) }];
    if (state.externalDir) {
      list.push({ id: 'external', label: 'External drive / folder', root: path.join(state.externalDir, BACKUP_FOLDER_NAME), parent: state.externalDir });
    }
    return list;
  }

  function rootFor(id) {
    const dest = destinations().find((d) => d.id === id);
    if (!dest) throw new Error('Unknown backup location.');
    return dest.root;
  }

  // ---- one backup run ----
  async function runBackup({ force = false } = {}) {
    if (running) return { skipped: 'already-running' };
    const state0 = readState();
    if (!force && state0.lastSuccessAt) {
      const ageH = (now() - new Date(state0.lastSuccessAt)) / 3600000;
      if (ageH < MIN_INTERVAL_HOURS) return { skipped: 'recent' };
    }
    running = true;
    const date = now();
    const name = snapshotNameFor(date); // stored name, ends in .sqlite.gz
    const rawStaged = path.join(stagingDir, name.replace(/\.gz$/, ''));
    const gzStaged = path.join(stagingDir, name);
    const state = readState();
    state.lastAttemptAt = date.toISOString();
    try {
      await ensureDir(stagingDir);
      await fsp.rm(rawStaged, { force: true });
      await fsp.rm(gzStaged, { force: true });

      // 1) consistent snapshot of the LIVE database (online backup API)
      await o.getDb().backup(rawStaged);
      // 2) make it a standalone single file, then verify it (worker thread)
      const snap = new Database(rawStaged);
      snap.pragma('journal_mode = DELETE');
      snap.close();
      const info = await inspectSnapshotAsync(rawStaged);
      if (!info.ok) throw new Error(`Snapshot failed verification: ${info.errors.join('; ')}`);
      // 3) compress (streamed, so the POS window keeps responding)
      const rawBytes = (await fsp.stat(rawStaged)).size;
      await gzipFile(rawStaged, gzStaged);
      const manifest = {
        format: 2,
        createdAt: date.toISOString(),
        appVersion: o.appVersion,
        sourceId: state.installId,
        orders: info.orders,
        items: info.items,
        customers: info.customers,
        rawBytes,
        sizeBytes: (await fsp.stat(gzStaged)).size,
        sha256: await sha256File(gzStaged),
      };

      // 4) every destination independently
      const results = [];
      for (const dest of destinations(state)) {
        const prev = state.destinations[dest.id] || {};
        try {
          if (dest.parent && !(await exists(dest.parent))) {
            throw new Error(`Folder not found: ${dest.parent} (drive removed or not plugged in?)`);
          }
          const dbDir = path.join(dest.root, 'db');
          await ensureDir(dbDir);
          await ensureReadme(dest.root);
          await atomicCopy(gzStaged, path.join(dbDir, name));
          await atomicWrite(path.join(dbDir, manifestNameFor(name)), JSON.stringify(manifest, null, 2));
          // paranoia: re-hash what actually landed on that disk
          if ((await sha256File(path.join(dbDir, name))) !== manifest.sha256) {
            throw new Error('Copy on disk does not match the snapshot (bad disk or drive?)');
          }
          const filesCopied = await mirrorFolders(o.userDataDir, path.join(dest.root, 'files'));
          const removed = await pruneDestination(dest.root, date, state.installId, o.maxTotalBytes);
          state.destinations[dest.id] = { lastSuccessAt: date.toISOString(), lastError: null, lastFile: name };
          results.push({ id: dest.id, ok: true, filesCopied, removed });
        } catch (err) {
          log(`[backup] ${dest.id} failed`, err);
          state.destinations[dest.id] = { ...prev, lastError: err.message };
          results.push({ id: dest.id, ok: false, error: err.message });
        }
      }

      const anyOk = results.some((r) => r.ok);
      if (anyOk) {
        state.lastSuccessAt = date.toISOString();
        state.lastError = results.some((r) => !r.ok) ? results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.error}`).join(' | ') : null;
      } else {
        state.lastError = results.map((r) => `${r.id}: ${r.error}`).join(' | ');
      }
      writeState(state);
      return { ok: anyOk, name, results, manifest };
    } catch (err) {
      log('[backup] failed', err);
      state.lastError = err.message;
      writeState(state);
      return { ok: false, error: err.message };
    } finally {
      await fsp.rm(rawStaged, { force: true }).catch(() => {});
      await fsp.rm(gzStaged, { force: true }).catch(() => {});
      running = false;
    }
  }

  // ---- status for the UI / startup warning ----
  async function getStatus() {
    const state = readState();
    const dests = [];
    const warnings = [];
    const advice = [];
    for (const d of destinations(state)) {
      const snaps = await listSnapshots(d.root).catch(() => []);
      const ds = state.destinations[d.id] || {};
      const available = d.parent ? await exists(d.parent) : true;
      dests.push({
        id: d.id,
        label: d.label,
        root: d.root,
        available,
        count: snaps.length,
        latest: snaps[0] || null,
        lastSuccessAt: ds.lastSuccessAt || null,
        lastError: ds.lastError || null,
      });
      if (d.id === 'external' && !available) {
        warnings.push(`External backup folder not found (${d.parent}). Plug the drive back in.`);
      }
    }
    if (!state.externalDir) {
      advice.push('Backups are only on this PC right now. Choose a USB / second-drive folder so they also survive a dead hard disk.');
    } else if (sameDriveRoot(state.externalDir, o.userDataDir)) {
      advice.push(`The external folder is on the same drive as the POS (${path.parse(path.resolve(state.externalDir)).root}). If that is just another folder on the same disk, a disk failure still loses everything - use a USB drive or another disk.`);
    }
    const lastGood = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;
    const ageH = (now() - (lastGood || startedAt)) / 3600000;
    if (ageH > WARN_AFTER_HOURS) {
      warnings.push(lastGood ? `Last successful backup was ${Math.floor(ageH / 24)} day(s) ago.` : 'No backup has completed yet.');
    }
    if (state.lastError && ageH > 24) warnings.push(`Last backup attempt failed: ${state.lastError}`);
    return { running, externalDir: state.externalDir, lastSuccessAt: state.lastSuccessAt, lastAttemptAt: state.lastAttemptAt, lastError: state.lastError, destinations: dests, warnings, advice, intervalHours: MIN_INTERVAL_HOURS };
  }

  async function setExternalDir(dir) {
    if (!dir) throw new Error('No folder chosen.');
    let resolved = path.resolve(dir);
    if (!(await exists(resolved))) throw new Error('That folder does not exist.');
    // Picked the POS-Backups folder itself (e.g. one copied from another PC)?
    // Use the folder that contains it.
    if (path.basename(resolved).toLowerCase() === BACKUP_FOLDER_NAME.toLowerCase()) resolved = path.dirname(resolved);
    if (resolved.toLowerCase().startsWith(path.resolve(o.userDataDir).toLowerCase())) {
      throw new Error("Pick a folder outside the POS's own data folder.");
    }
    // prove we can really write there before accepting it
    const probe = path.join(resolved, `.pos-write-test-${process.pid}`);
    try {
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
    } catch {
      throw new Error('Cannot write to that folder. Pick another one (or check the drive is not read-only).');
    }
    const state = readState();
    state.externalDir = resolved;
    writeState(state);
    return getStatus();
  }

  function clearExternalDir() {
    const state = readState();
    state.externalDir = null;
    delete state.destinations.external;
    writeState(state);
    return getStatus();
  }

  async function list(id) {
    return listSnapshots(rootFor(id));
  }

  // ---- restore ----
  /**
   * @param {string} id        'local' | 'external'
   * @param {string} fileName  a snapshot name from list(id) - validated, never a path
   */
  async function restore(id, fileName) {
    if (running) throw new Error('A backup is running right now. Try again in a minute.');
    if (!SNAPSHOT_RE.test(String(fileName))) throw new Error('Invalid backup file.');
    if (!o.closeDb || !o.reopenDb) throw new Error('Restore is not available in this build.');
    const root = rootFor(id);
    const snapFile = path.join(root, 'db', fileName);
    if (!(await exists(snapFile))) throw new Error('That backup file no longer exists.');

    // 1) verify BEFORE touching anything
    let manifest = null;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(root, 'db', manifestNameFor(fileName)), 'utf8'));
    } catch {
      manifest = null;
    }
    if (manifest?.sha256 && (await sha256File(snapFile)) !== manifest.sha256) {
      throw new Error('This backup file does not match its checksum (it was changed or corrupted).');
    }
    if (manifest?.appVersion && compareVersions(manifest.appVersion, o.appVersion) > 0) {
      throw new Error(`This backup was made by a newer POS version (${manifest.appVersion}). Update the POS first.`);
    }
    // unpack next to the live database (same disk -> the final swap is an atomic rename)
    const dbPath = path.join(o.userDataDir, 'pos.sqlite');
    const incoming = `${dbPath}.restoring`;
    await fsp.rm(incoming, { force: true });
    if (fileName.endsWith('.gz')) await gunzipFile(snapFile, incoming);
    else await fsp.copyFile(snapFile, incoming);
    const info = await inspectSnapshotAsync(incoming);
    if (!info.ok) {
      await fsp.rm(incoming, { force: true });
      throw new Error(`This backup is damaged and was not restored: ${info.errors.join('; ')}`);
    }

    // 2) safety copy of what is there right now
    await ensureDir(preRestoreDir);
    const safety = path.join(preRestoreDir, `POS-DB_pre-restore_${stampFor(now())}.sqlite`);
    await o.getDb().backup(safety);
    const olds = (await fsp.readdir(preRestoreDir)).filter((n) => n.startsWith('POS-DB_pre-restore_') && n.endsWith('.sqlite')).sort().reverse();
    for (const n of olds.slice(KEEP_PRE_RESTORE)) await fsp.rm(path.join(preRestoreDir, n), { force: true });

    // 3) images first (a failure here leaves the database untouched)
    try {
      await mirrorFolders(path.join(root, 'files'), o.userDataDir);
    } catch (err) {
      await fsp.rm(incoming, { force: true }).catch(() => {});
      throw err;
    }

    // 4) swap the database file in
    o.closeDb();
    try {
      await fsp.rm(`${dbPath}-wal`, { force: true });
      await fsp.rm(`${dbPath}-shm`, { force: true });
      await fsp.rename(incoming, dbPath);
    } catch (err) {
      await fsp.rm(incoming, { force: true }).catch(() => {});
      o.reopenDb(); // put the app back on the untouched database
      throw err;
    }

    // 5) carry on the restored backup's lineage (so retention keeps managing
    //    that restaurant's snapshots after a move to a new PC)
    if (manifest?.sourceId) {
      const st = readState();
      st.installId = manifest.sourceId;
      writeState(st);
    }
    return { restored: true, from: fileName, orders: info.orders, items: info.items, customers: info.customers, safetyCopy: safety };
  }

  // ---- scheduler ----
  function start({ startDelayMs = 30000, checkEveryMs = 3600000 } = {}) {
    stop();
    const tick = () => {
      runBackup().catch((err) => log('[backup] scheduler error', err));
    };
    const first = setTimeout(tick, startDelayMs);
    const every = setInterval(tick, checkEveryMs);
    first.unref?.();
    every.unref?.();
    timers = [first, every];
  }
  function stop() {
    timers.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    timers = [];
  }

  return { start, stop, runNow: () => runBackup({ force: true }), runIfDue: () => runBackup(), getStatus, setExternalDir, clearExternalDir, list, restore, isRunning: () => running };
}

module.exports = {
  createBackupManager,
  // exported for tests
  inspectSnapshot,
  inspectSnapshotAsync,
  chooseSnapshotsToKeep,
  gunzipFile,
  manifestNameFor,
  snapshotNameFor,
  SNAPSHOT_RE,
  BACKUP_FOLDER_NAME,
  FILE_DIRS,
};
