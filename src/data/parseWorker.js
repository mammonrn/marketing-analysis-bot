/**
 * Worker-thread entry point for reading a workbook.
 *
 * Deliberately tiny, and deliberately importing only `workbook.js`: that
 * module and everything below it (`fileTypes` -> `aggregate` -> `transform`
 * -> `sites`, plus `dates`) is pure computation. Nothing here may reach
 * `db.js` — better-sqlite3 is a native addon whose connections are not safe
 * to share across threads, so the parsed rows travel back to the main thread
 * and are written to SQLite there.
 *
 * Protocol, all via postMessage:
 *   { type: 'progress', phase, ... }  zero or more, while working
 *   { type: 'done', result }          exactly one, on success
 * Failures are not sent as messages — the exception propagates and the host
 * sees it through the worker's own `error` event.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { readAndShapeRows } from './workbook.js';
import { applyFxOverride } from './sites.js';

// This thread's `sites.js` is a fresh module graph, so it holds the rates that
// shipped in the config and knows nothing of any change made from chat. The
// host resolved the rate in force before spawning us and passed it down;
// replaying it here is what keeps `aggregateBonusLog` converting at the same
// rate on both the worker and the inline path. Still no `db.js` in sight —
// `sites.js` is pure, and the override arrives as data.
const { fxState, ...job } = workerData;
if (fxState) {
  applyFxOverride(fxState.canonical, { fxRate: fxState.fxRate, fxRateAsOf: fxState.fxRateAsOf });
}

const result = await readAndShapeRows({
  ...job,
  onProgress: (update) => parentPort.postMessage({ type: 'progress', ...update }),
});

parentPort.postMessage({ type: 'done', result });
