/**
 * Runs a workbook read either inline or on a worker thread, and is the only
 * place that decides which.
 *
 * Why a thread at all: reading a 150k-row export is one long synchronous
 * SheetJS call. On the main thread it blocks the event loop for tens of
 * seconds, which means Telegram polling stops, every other chat waits, and
 * even the "typing" indicator freezes. Off-thread, the main loop stays free
 * to answer other people and to report progress on this one.
 *
 * Why not always: spawning a worker costs a fresh module graph (~40-80ms)
 * plus a structured clone of the rows on the way back. For the small monthly
 * exports — a few dozen rows, read in single-digit milliseconds — that is
 * pure overhead, so anything under `WORKER_MIN_BYTES` runs inline exactly as
 * it did before.
 */

import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAndShapeRows } from './workbook.js';
import { logger } from '../logger.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parseWorker.js');

/**
 * 2MB of .xlsx is already tens of thousands of rows — comfortably past the
 * point where a thread pays for itself, and far above every routine monthly
 * export in this project (the largest is ~37KB).
 */
export const WORKER_MIN_BYTES = 2 * 1024 * 1024;

function sizeOf({ filePath, buffer }) {
  if (buffer) return buffer.length;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function runOnWorker({ filePath, buffer, fileType, shape, dateColumn, onProgress }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { filePath, buffer, fileType, shape, dateColumn },
      // The rows come back by structured clone anyway; keeping the default
      // resource limits means a runaway file kills the worker, not the bot.
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
      worker.terminate().catch(() => {});
    };

    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        // A throwing progress callback must not take the parse down with it.
        try {
          onProgress?.(msg);
        } catch (err) {
          logger.warn('parse progress callback threw', { message: err?.message });
        }
        return;
      }
      if (msg?.type === 'done') finish(resolve, msg.result);
    });

    worker.on('error', (err) => finish(reject, err));

    // Covers the cases `error` does not: an OOM kill, or a worker that exits
    // without ever sending its result. Without this the caller would hang.
    worker.on('exit', (code) => {
      finish(reject, new Error(`parse worker exited with code ${code} before returning rows`));
    });
  });
}

/**
 * Reads and shapes a workbook's rows. Same result either way — the thread is
 * an execution detail, not a behaviour change.
 */
export async function parseWorkbookRows(job = {}) {
  const bytes = sizeOf(job);

  if (bytes < WORKER_MIN_BYTES) {
    return readAndShapeRows(job);
  }

  const startedAt = Date.now();
  const { fileType, shape = 'typed' } = job;
  logger.info('parsing workbook on a worker thread', { fileType, bytes, shape });
  try {
    const result = await runOnWorker(job);
    logger.info('worker parse finished', {
      fileType,
      shape,
      rows: Array.isArray(result) ? result.length : undefined,
      ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    logger.error('worker parse failed', { fileType, bytes, message: err?.message });
    throw err;
  }
}

/**
 * Tally of `{ 'YYYY-MM': rowCount }` for a workbook's date column.
 *
 * Separate from `parseWorkbookRows` because the point is what it does *not*
 * return: ingest only needs to know which month a file belongs to, and
 * sending 150k row objects back across the thread boundary to work that out
 * cost more memory than the read.
 */
export function countYearMonths({ filePath, buffer, dateColumn, onProgress } = {}) {
  return parseWorkbookRows({ filePath, buffer, dateColumn, shape: 'year-month', onProgress });
}
