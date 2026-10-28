'use strict';

/**
 * Runs inspectSnapshot() on a worker thread so verifying a big database
 * (integrity_check takes ~2s on a 5-year, 500k-order database) never
 * freezes the POS window. See inspectSnapshotAsync() in backupService.js.
 */
const { parentPort, workerData } = require('worker_threads');
const { inspectSnapshot } = require('./backupService');

parentPort.postMessage(inspectSnapshot(workerData.file));
