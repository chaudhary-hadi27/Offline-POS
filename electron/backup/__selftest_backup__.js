'use strict';

/**
 * Self-test for electron/backup/backupService.js - runs against a REAL
 * SQLite database in a temp folder, no Electron needed:
 *
 *     npm run db:test:backup
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { initDatabase, getDb, closeDatabase } = require('../database/db');
const { createBackupManager, chooseSnapshotsToKeep, snapshotNameFor, inspectSnapshot, gunzipFile, manifestNameFor } = require('./backupService');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function seedOrders(db, n) {
  const shiftId = db.prepare("INSERT INTO shifts (opened_by, opening_float) VALUES ('t', 0)").run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO orders (shift_id, order_type, subtotal, tax_rate, tax_amount, total, status)
                          VALUES (?, 'Takeaway', 100, 0, 0, 100, 'COMPLETED')`);
  for (let i = 0; i < n; i++) ins.run(shiftId);
}

/** snapshots are stored gzipped - unpack to a temp file so inspectSnapshot() can open it */
async function inspectGz(file) {
  const out = path.join(os.tmpdir(), `inspect-${process.pid}-${Date.now()}.sqlite`);
  await gunzipFile(file, out);
  const info = inspectSnapshot(out);
  fs.rmSync(out, { force: true });
  return info;
}

const countOrders = () => getDb().prepare('SELECT COUNT(*) AS c FROM orders').get().c;

(async () => {
  const userData = tmp('pos-userdata');
  const localParent = tmp('pos-docs');
  const externalDir = tmp('pos-usb');
  initDatabase(userData);
  const db = getDb();

  // a few items + images (one "gallery pick" copied into item-images, one custom gallery, one deal image)
  db.prepare("INSERT INTO items (sku, name, category, price, image_path) VALUES ('A1', 'Pizza', 'Food', 500, 'item-images/item-1.jpg')").run();
  fs.mkdirSync(path.join(userData, 'item-images'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'custom-gallery'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'deal-images'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'item-images', 'item-1.jpg'), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(userData, 'custom-gallery', 'crown-crust.jpg'), crypto.randomBytes(1024));
  fs.writeFileSync(path.join(userData, 'custom-gallery', 'manifest.json'), '[{"name":"Crown Crust","filename":"crown-crust.jpg"}]');
  fs.writeFileSync(path.join(userData, 'deal-images', 'template-1.jpg'), crypto.randomBytes(512));
  seedOrders(db, 25);

  let clock = new Date(2026, 9, 26, 9, 0, 0);
  const mgr = createBackupManager({
    getDb,
    userDataDir: userData,
    defaultLocalDir: localParent,
    appVersion: '1.0.0',
    closeDb: closeDatabase,
    reopenDb: () => initDatabase(userData),
    now: () => clock,
  });

  const localRoot = path.join(localParent, 'POS-Backups');
  const extRoot = path.join(externalDir, 'POS-Backups');

  await test('first backup writes a verified snapshot + manifest + image mirror (local only)', async () => {
    const r = await mgr.runNow();
    assert.strictEqual(r.ok, true);
    const name = snapshotNameFor(new Date(2026, 9, 26, 9, 0, 0));
    assert.ok(fs.existsSync(path.join(localRoot, 'db', name)));
    assert.ok(name.endsWith('.sqlite.gz'));
    const man = JSON.parse(fs.readFileSync(path.join(localRoot, 'db', manifestNameFor(name)), 'utf8'));
    assert.strictEqual(man.orders, 25);
    assert.strictEqual(man.items, 1);
    assert.ok(/^[0-9a-f]{64}$/.test(man.sha256));
    assert.ok(man.sourceId, 'manifest carries the install id');
    assert.ok(man.sizeBytes < man.rawBytes, 'snapshot is compressed');
    assert.ok((await inspectGz(path.join(localRoot, 'db', name))).ok);
    assert.ok(fs.existsSync(path.join(localRoot, 'README.txt')), 'README for humans');
    for (const f of ['item-images/item-1.jpg', 'custom-gallery/crown-crust.jpg', 'custom-gallery/manifest.json', 'deal-images/template-1.jpg']) {
      assert.ok(fs.existsSync(path.join(localRoot, 'files', f)), `mirror missing ${f}`);
    }
    // no stray staging / tmp files
    assert.deepStrictEqual(fs.readdirSync(path.join(userData, 'backup-staging')), []);
    assert.ok(fs.readdirSync(path.join(localRoot, 'db')).every((n) => !n.endsWith('.tmp')));
  });

  await test('status advises an external copy when none is set', async () => {
    const s = await mgr.getStatus();
    assert.ok(s.advice.length >= 1);
    assert.strictEqual(s.destinations.length, 1);
    assert.strictEqual(s.destinations[0].count, 1);
    assert.deepStrictEqual(s.warnings, []);
  });

  await test('runIfDue skips when the last backup is recent, runs after 12h', async () => {
    assert.strictEqual((await mgr.runIfDue()).skipped, 'recent');
    clock = new Date(2026, 9, 26, 22, 0, 0);
    const r = await mgr.runIfDue();
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await mgr.list('local')).length, 2);
  });

  await test('image mirror is incremental (unchanged files are not recopied)', async () => {
    const mirrored = path.join(localRoot, 'files', 'item-images', 'item-1.jpg');
    const before = fs.statSync(mirrored).ino;
    clock = new Date(2026, 9, 27, 10, 0, 0);
    await mgr.runNow();
    assert.strictEqual(fs.statSync(mirrored).ino, before);
    // a changed image IS picked up
    fs.writeFileSync(path.join(userData, 'item-images', 'item-1.jpg'), crypto.randomBytes(4096));
    fs.writeFileSync(path.join(userData, 'item-images', 'item-2.jpg'), crypto.randomBytes(300));
    clock = new Date(2026, 9, 27, 11, 0, 0);
    await mgr.runNow();
    assert.strictEqual(fs.statSync(mirrored).size, 4096);
    assert.ok(fs.existsSync(path.join(localRoot, 'files', 'item-images', 'item-2.jpg')));
  });

  await test('external folder: validated, written independently, survives being unplugged', async () => {
    await assert.rejects(() => mgr.setExternalDir(path.join(externalDir, 'nope')), /does not exist/);
    await assert.rejects(() => mgr.setExternalDir(path.join(userData, 'item-images')), /outside/);
    const s = await mgr.setExternalDir(externalDir);
    assert.strictEqual(s.destinations.length, 2);
    clock = new Date(2026, 9, 27, 12, 0, 0);
    const r = await mgr.runNow();
    assert.ok(r.results.every((x) => x.ok));
    assert.strictEqual((await mgr.list('external')).length, 1);

    // "unplug" the USB: local still succeeds, external reports a clear error + warning
    const unplugged = `${externalDir}-gone`;
    fs.renameSync(externalDir, unplugged);
    clock = new Date(2026, 9, 27, 13, 0, 0);
    const r2 = await mgr.runNow();
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.results.find((x) => x.id === 'local').ok, true);
    assert.strictEqual(r2.results.find((x) => x.id === 'external').ok, false);
    const st = await mgr.getStatus();
    assert.ok(st.warnings.some((w) => /External backup folder not found/.test(w)));
    fs.renameSync(unplugged, externalDir);
  });

  await test('backup taken while the POS keeps writing orders is still consistent', async () => {
    const writer = setInterval(() => seedOrdersQuiet(), 2);
    function seedOrdersQuiet() {
      try {
        getDb().prepare("INSERT INTO orders (shift_id, order_type, subtotal, tax_rate, tax_amount, total, status) VALUES (1, 'Takeaway', 50, 0, 0, 50, 'COMPLETED')").run();
      } catch { /* none expected */ }
    }
    clock = new Date(2026, 9, 28, 9, 0, 0);
    const r = await mgr.runNow();
    clearInterval(writer);
    assert.strictEqual(r.ok, true);
    const snap = path.join(localRoot, 'db', r.name);
    const info = await inspectGz(snap);
    assert.ok(info.ok, info.errors.join(','));
    assert.ok(info.orders >= 25);
  });

  await test('retention keeps 7 days / 4 weeks / 3 months and always the newest', () => {
    const names = [];
    for (let d = 0; d < 120; d++) {
      const date = new Date(2026, 9, 28 - d, 9, 0, 0);
      names.push(snapshotNameFor(date));
      names.push(snapshotNameFor(new Date(2026, 9, 28 - d, 21, 0, 0))); // two per day
    }
    const keep = chooseSnapshotsToKeep(names, new Date(2026, 9, 28, 22, 0, 0));
    // pressing "Back up now" many times in one hour keeps only that hour's newest
    const burst = [0, 5, 10, 20].map((m) => snapshotNameFor(new Date(2026, 9, 28, 21, m, 0)));
    const keepBurst = chooseSnapshotsToKeep(burst, new Date(2026, 9, 28, 22, 0, 0));
    assert.deepStrictEqual([...keepBurst], [snapshotNameFor(new Date(2026, 9, 28, 21, 20, 0))]);
    assert.ok(keep.has(snapshotNameFor(new Date(2026, 9, 28, 21, 0, 0))), 'newest kept');
    assert.ok(keep.has(snapshotNameFor(new Date(2026, 9, 28, 9, 0, 0))), 'same-day earlier copy kept (last 48h)');
    // a copy from 10 days ago keeps only its day's newest... and only if its week/month slot needs it
    assert.ok(!keep.has(snapshotNameFor(new Date(2026, 9, 18, 9, 0, 0))), 'old same-day extra pruned');
    assert.ok(keep.size >= 12 && keep.size <= 20, `kept ${keep.size}`);
  });

  await test('restore refuses path tricks and unknown locations', async () => {
    await assert.rejects(() => mgr.restore('local', '../../etc/passwd'), /Invalid backup file/);
    await assert.rejects(() => mgr.restore('local', 'POS-DB_2026-10-26_090500.sqlite.tmp'), /Invalid backup file/);
    await assert.rejects(() => mgr.restore('cloud', snapshotNameFor(clock)), /Unknown backup location/);
  });

  await test('a tampered backup is refused and the live database is untouched', async () => {
    const snaps = await mgr.list('local');
    const target = snaps[snaps.length - 1].name;
    const file = path.join(localRoot, 'db', target);
    const before = countOrders();
    const original = fs.readFileSync(file);
    const bad = Buffer.from(original);
    bad[bad.length - 100] ^= 0xff;
    fs.writeFileSync(file, bad);
    await assert.rejects(() => mgr.restore('local', target), /checksum|damaged/);
    assert.strictEqual(countOrders(), before);
    fs.writeFileSync(file, original);
  });

  await test('restore brings back orders AND deleted image files, and keeps a safety copy', async () => {
    const snaps = await mgr.list('local');
    const target = snaps.find((s) => s.orders === 25);
    assert.ok(target, 'a 25-order snapshot exists');

    // disaster: orders wiped, an image lost
    getDb().prepare('DELETE FROM order_items').run();
    getDb().prepare('DELETE FROM orders').run();
    fs.rmSync(path.join(userData, 'custom-gallery', 'crown-crust.jpg'));
    assert.strictEqual(countOrders(), 0);

    const r = await mgr.restore('local', target.name);
    assert.strictEqual(r.restored, true);
    // the manager closed the DB and reopened nothing (success path) - the app relaunches; reopen like it would
    initDatabase(userData);
    assert.strictEqual(countOrders(), 25);
    assert.ok(fs.existsSync(path.join(userData, 'custom-gallery', 'crown-crust.jpg')), 'image restored');
    const safety = fs.readdirSync(path.join(userData, 'pre-restore'));
    assert.strictEqual(safety.length, 1);
    assert.ok(inspectSnapshot(path.join(userData, 'pre-restore', safety[0])).ok);
    assert.ok(!fs.existsSync(path.join(userData, 'pos.sqlite.restoring')));
    assert.ok(!fs.existsSync(path.join(userData, 'pos.sqlite.restoring')));
  });

  await test('another PC\'s backups in the same folder are never pruned; a size budget keeps the 3 newest', async () => {
    const dbDir = path.join(localRoot, 'db');
    const foreign = snapshotNameFor(new Date(2025, 0, 5, 9, 0, 0)); // ancient, would normally be pruned
    fs.writeFileSync(path.join(dbDir, foreign), 'not a real snapshot');
    fs.writeFileSync(path.join(dbDir, manifestNameFor(foreign)), JSON.stringify({ sourceId: 'some-other-pc', sizeBytes: 19 }));
    // two old snapshots with no manifest at all -> treated as ours; same day, so the older one is surplus
    const legacyKeep = snapshotNameFor(new Date(2025, 0, 6, 9, 0, 0));
    const legacyExtra = snapshotNameFor(new Date(2025, 0, 6, 8, 0, 0));
    fs.writeFileSync(path.join(dbDir, legacyKeep), 'x');
    fs.writeFileSync(path.join(dbDir, legacyExtra), 'x');
    clock = new Date(2026, 9, 29, 9, 0, 0);
    await mgr.runNow();
    assert.ok(fs.existsSync(path.join(dbDir, foreign)), 'foreign snapshot survived');
    assert.ok(fs.existsSync(path.join(dbDir, legacyKeep)), 'newest of its day/month is kept even though old');
    assert.ok(!fs.existsSync(path.join(dbDir, legacyExtra)), 'own older same-day surplus pruned');

    // tiny budget: trims down to the 3 newest of OUR snapshots
    const tiny = createBackupManager({ getDb, userDataDir: userData, defaultLocalDir: localParent, appVersion: '1.0.0', now: () => new Date(2026, 9, 30, 9, 0, 0), maxTotalBytes: 1 });
    await tiny.runNow();
    const ours = fs.readdirSync(dbDir).filter((n) => n.endsWith('.sqlite.gz') && n !== foreign);
    assert.strictEqual(ours.length, 3, `kept ${ours.length}`);
  });

  await test('picking the POS-Backups folder itself (copied from another PC) works', async () => {
    const copied = tmp('pos-copied');
    fs.cpSync(localRoot, path.join(copied, 'POS-Backups'), { recursive: true });
    const s = await mgr.setExternalDir(path.join(copied, 'POS-Backups'));
    assert.strictEqual(s.externalDir, path.resolve(copied));
    const listed = await mgr.list('external');
    assert.ok(listed.length >= 3);
    await mgr.setExternalDir(externalDir); // put the USB back
  });

  await test('restoring a backup from another install adopts its lineage', async () => {
    const dbDir = path.join(localRoot, 'db');
    const snaps = (await mgr.list('local')).filter((s) => s.orders === 25 || s.orders > 25);
    const target = snaps[0];
    const mpath = path.join(dbDir, manifestNameFor(target.name));
    const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    const before = m.sourceId;
    // pretend the snapshot came from the OLD PC: new sourceId in the manifest
    m.sourceId = 'old-pc-lineage';
    fs.writeFileSync(mpath, JSON.stringify(m));
    await mgr.restore('local', target.name);
    initDatabase(userData);
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'backup-state.json'), 'utf8'));
    assert.strictEqual(state.installId, 'old-pc-lineage');
    assert.notStrictEqual(state.installId, before);
  });

  await test('backup state survives a restore (it lives outside the database)', async () => {
    const s = await mgr.getStatus();
    assert.strictEqual(s.externalDir, path.resolve(externalDir));
  });

  closeDatabase();
  console.log(`\n${passed} backup checks passed.`);
})().catch((err) => {
  console.error('\nBACKUP SELF-TEST FAILED:', err);
  process.exit(1);
});
