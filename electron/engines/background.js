'use strict';

/**
 * Background-removal facade.
 *
 * The actual inference runs in electron/workers/background-worker.cjs, in a
 * separate process. This module owns the process lifecycle, serialises jobs so
 * only one model runs at a time, forwards progress, and makes cancellation
 * deterministic (cancelling kills the worker instead of leaving a runaway
 * inference in the main process).
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const U = require('../util');

const WORKER = path.join(__dirname, '..', 'workers', 'background-worker.cjs');
const IDLE_MS = 3 * 60 * 1000;
const REQUEST_MS = 10 * 60 * 1000;
const MAX_REQUESTS_HINT = 8;

let child = null;
let pending = null;
let queue = [];
let running = false;
let seq = 0;
let idleTimer = null;
let exitReason = '';
let availabilityCache = null;
let availabilityAt = 0;

function packageInfo() {
  const now = Date.now();
  if (availabilityCache && now - availabilityAt < 10000) return availabilityCache;
  let info;
  try {
    const entry = require.resolve('@imgly/background-removal-node');
    const root = path.resolve(path.dirname(entry), '..');
    const dist = path.join(root, 'dist');
    const ok = fs.existsSync(entry) && fs.existsSync(path.join(dist, 'resources.json'));
    info = {
      available: ok,
      root,
      dist,
      entry,
      publicPath: ok ? require('url').pathToFileURL(dist + path.sep).href : '',
      error: ok ? null : 'The background removal model files are missing.',
    };
  } catch {
    info = {
      available: false,
      root: '',
      dist: '',
      entry: '',
      publicPath: '',
      error: 'The background removal component is not installed.',
    };
  }
  availabilityCache = info;
  availabilityAt = now;
  return info;
}

function available() {
  return !!packageInfo().available;
}

function modelName() {
  const m = String(process.env.MORPH_BG_MODEL || 'medium').toLowerCase();
  return m === 'small' || m === 'medium' || m === 'large' ? m : 'medium';
}

function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdle() {
  clearIdle();
  idleTimer = unrefTimer(setTimeout(() => { if (!pending && !queue.length) killChild(); }, IDLE_MS));
}

function cleanupFiles(p) {
  if (!p) return;
  if (p.input) U.rmQuiet(p.input);
  if (p.output) U.rmQuiet(p.output);
}

function detachAbort(p) {
  if (p && p.signal && p.onAbort) {
    try { p.signal.removeEventListener('abort', p.onAbort); } catch { /* ignore */ }
  }
}

/**
 * Settle the in-flight request exactly once.
 * `kill` is used for timeouts, cancellations and native crashes.
 */
function settle(p, err, result, kill) {
  if (!p || p.settled) return;
  p.settled = true;
  if (p.timer) clearTimeout(p.timer);
  detachAbort(p);
  cleanupFiles(p);
  if (pending === p) pending = null;
  if (kill) killChild();
  if (err) p.reject(err); else p.resolve(result);
  scheduleIdle();
}

function killChild() {
  const c = child;
  child = null;
  if (!c) return;
  try { if (c.connected) c.send({ type: 'shutdown' }); } catch { /* ignore */ }
  try { c.kill(); } catch { /* ignore */ }
}

function childFailure(code, signal) {
  const base = exitReason || (code === 3221225477 || code === -1073741819
    ? 'The background removal engine crashed. Please try again.'
    : signal
      ? 'The background removal engine was stopped. Please try again.'
      : 'The background removal engine stopped unexpectedly. Please try again.');
  exitReason = '';
  return new Error(base);
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const p = pending;
  if (!p || msg.id !== p.id) return;

  if (msg.type === 'progress') {
    if (!p.onProgress) return;
    try { p.onProgress(msg.key, msg.current, msg.total); } catch { /* ignore */ }
    return;
  }

  if (msg.type === 'result') {
    try {
      const buf = fs.readFileSync(msg.output);
      if (!buf.length) throw new Error('The background removal engine returned an empty image.');
      settle(p, null, buf, false);
    } catch (e) {
      settle(p, new Error('The background removal result could not be read. Please try again.'), null, true);
    }
    return;
  }

  if (msg.type === 'error') {
    settle(p, new Error(msg.message || 'Background removal failed.'), null, false);
    return;
  }

  if (msg.type === 'fatal') {
    exitReason = msg.message || 'The background removal engine crashed.';
    settle(p, new Error(exitReason), null, true);
  }
}

function spawnChild() {
  const info = packageInfo();
  if (!info.available) throw new Error('Background removal is not available in this build. Reinstall MorphEra to restore it.');

  const env = { ...process.env };
  // Electron's executable doubles as a Node runtime when this flag is set.
  // Plain Node ignores it, so the same code works in development and tests.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  const c = fork(WORKER, [], {
    env,
    execPath: process.execPath,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child = c;
  exitReason = '';

  let stderr = '';
  if (c.stderr) {
    c.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
      if (process.env.MORPH_DEBUG) process.stderr.write(d);
    });
  }
  c.on('message', onMessage);
  c.on('error', (e) => {
    if (child === c) child = null;
    const p = pending;
    if (p) settle(p, new Error('The background removal engine could not start: ' + ((e && e.message) || 'unknown error')), null, true);
  });
  c.on('exit', (code, signal) => {
    if (child === c) child = null;
    const p = pending;
    if (p) {
      let message = childFailure(code, signal);
      if (process.env.MORPH_DEBUG && stderr.trim()) message = new Error(message.message + '\n' + stderr.trim().slice(-800));
      settle(p, message, null, false);
    }
    scheduleIdle();
  });
  return c;
}

function ensureChild() {
  if (child && child.connected) return child;
  return spawnChild();
}

function runOne(job) {
  return new Promise((resolve, reject) => {
    if (job.signal && job.signal.aborted) { reject(new U.Cancelled()); return; }
    const info = packageInfo();
    if (!info.available) { reject(new Error('Background removal is not available in this build. Reinstall MorphEra to restore it.')); return; }

    const p = {
      id: ++seq,
      input: U.tmpFile('png', 'bg-in'),
      output: U.tmpFile('png', 'bg-out'),
      signal: job.signal || null,
      onProgress: job.onProgress || null,
      resolve,
      reject,
      settled: false,
      timer: null,
      onAbort: null,
    };
    p.timer = setTimeout(() => {
      exitReason = 'Background removal took too long and was stopped. Try a smaller image.';
      settle(p, new Error(exitReason), null, true);
    }, REQUEST_MS);

    // Mark this request pending before anything asynchronous can happen. The
    // abort listener below may otherwise settle a request that has not been
    // registered yet, leaving a stray job behind.
    pending = p;

    if (p.signal) {
      p.onAbort = () => {
        exitReason = '';
        settle(p, new U.Cancelled(), null, true);
      };
      p.signal.addEventListener('abort', p.onAbort, { once: true });
      // An AbortSignal can fire between the initial check and addEventListener.
      if (p.signal.aborted) { p.onAbort(); return; }
    }

    try {
      fs.writeFileSync(p.input, job.buffer);
    } catch (e) {
      settle(p, new Error('The image could not be prepared for background removal.'), null, false);
      return;
    }

    try {
      const c = ensureChild();
      c.send({
        type: 'remove',
        id: p.id,
        input: p.input,
        output: p.output,
        publicPath: info.publicPath,
        model: modelName(),
      }, (err) => {
        if (err) settle(p, new Error('The background removal engine is not responding. Please try again.'), null, true);
      });
    } catch (e) {
      settle(p, new Error((e && e.message) || 'The background removal engine could not start.'), null, true);
    }
  });
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    const buf = await runOne(job);
    job.resolve(buf);
  } catch (e) {
    job.reject(e instanceof Error ? e : new Error(String(e)));
  } finally {
    running = false;
    if (queue.length) setImmediate(pump);
  }
}

/**
 * Remove the background from a PNG buffer.
 * Jobs are serialised to keep peak memory predictable.
 */
function removeBackground(ctx, pngBuffer) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
      reject(new Error('The image is empty or could not be read.'));
      return;
    }
    const job = {
      buffer: pngBuffer,
      signal: ctx && ctx.signal ? ctx.signal : null,
      onProgress: (key, current, total) => {
        if (!ctx || typeof ctx.progress !== 'function') return;
        const k = String(key || '');
        if (k.startsWith('fetch:')) {
          const frac = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
          ctx.progress(0.30 + frac * 0.08, frac >= 1 ? 'Loading background model' : 'Preparing background removal');
        } else if (k.startsWith('compute:')) {
          ctx.progress(0.40, 'Removing background');
        }
      },
      resolve,
      reject,
    };
    queue.push(job);
    pump();
  });
}

function shutdown() {
  clearIdle();
  for (const job of queue.splice(0)) job.reject(new U.Cancelled());
  if (pending) {
    exitReason = '';
    settle(pending, new U.Cancelled(), null, true);
  }
  killChild();
}

process.on('exit', () => { try { killChild(); } catch { /* ignore */ } });

module.exports = {
  available,
  removeBackground,
  shutdown,
  packageInfo,
  MAX_REQUESTS_HINT,
};
