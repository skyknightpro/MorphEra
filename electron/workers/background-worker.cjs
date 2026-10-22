'use strict';

/**
 * Isolated background-removal worker.
 *
 * The ONNX runtime used by @imgly/background-removal-node can be memory hungry
 * and, in rare cases, crash the native layer. Running it in a separate process
 * keeps the main MorphEra process responsive and means a crash can never take
 * the whole app down. The parent recycles this process when it has handled a
 * handful of images or after a period of inactivity.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let loadPromise = null;
let packageRoot = '';
let handled = 0;

function packageDir() {
  if (packageRoot) return packageRoot;
  const entry = require.resolve('@imgly/background-removal-node');
  packageRoot = path.resolve(path.dirname(entry), '..');
  return packageRoot;
}

function loadEngine() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const mod = require('@imgly/background-removal-node');
    const fn = mod.removeBackground || (mod.default && mod.default.removeBackground);
    if (typeof fn !== 'function') throw new Error('The background removal engine is incomplete. Reinstall MorphEra.');
    return fn;
  })();
  return loadPromise;
}

function friendly(e) {
  const raw = String((e && e.message) || e || 'Background removal failed.');
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(raw)) {
    return 'The background removal component is missing. Reinstall MorphEra to restore it.';
  }
  if (/Resource .* not found|publicPath|models\//i.test(raw)) {
    return 'The background removal model files are missing or damaged. Reinstall MorphEra to restore them.';
  }
  if (/out of memory|ENOMEM|allocation failed/i.test(raw)) {
    return 'There was not enough memory to remove the background. Close other apps or try a smaller image.';
  }
  if (/Failed to create session/i.test(raw)) {
    return 'The background removal engine could not start. Reinstall MorphEra or try again.';
  }
  return raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
}

function send(msg, cb) {
  try {
    if (process.send) return process.send(msg, cb);
  } catch { /* parent disappeared */ }
  if (cb) cb();
  return false;
}

async function handleRemove(msg) {
  const started = Date.now();
  try {
    const removeBackground = await loadEngine();
    const config = {
      publicPath: msg.publicPath || pathToFileURL(path.join(packageDir(), 'dist') + path.sep).href,
      // IMPORTANT: the package defaults to proxyToWorker=true. In Electron on
      // Windows that path crashes the native ONNX runtime with an access
      // violation (0xC0000005). Running in this dedicated process is safer.
      proxyToWorker: false,
      debug: false,
      model: msg.model || 'medium',
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        send({ type: 'progress', id: msg.id, key, current, total });
      },
    };

    const input = fs.readFileSync(msg.input);
    if (!input.length) throw new Error('The image could not be read.');
    const blob = await removeBackground(new Blob([input], { type: 'image/png' }), config);
    if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('The background removal engine returned no image.');
    const out = Buffer.from(await blob.arrayBuffer());
    if (!out.length) throw new Error('The background removal engine returned an empty image.');
    fs.writeFileSync(msg.output, out);
    handled++;
    send({ type: 'result', id: msg.id, output: msg.output, bytes: out.length, ms: Date.now() - started }, () => {
      // Recycle before V8/native memory can fragment indefinitely.
      if (handled >= 8) setTimeout(() => process.exit(0), 50);
    });
  } catch (e) {
    send({ type: 'error', id: msg.id, message: friendly(e) });
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'remove') handleRemove(msg);
  if (msg.type === 'ping') send({ type: 'pong', id: msg.id });
  if (msg.type === 'shutdown') process.exit(0);
});

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (e) => {
  send({ type: 'fatal', message: friendly(e) });
  setTimeout(() => process.exit(1), 30);
});
process.on('unhandledRejection', (e) => {
  // The request handler catches its own errors; this is a last-resort log.
  if (process.env.MORPH_DEBUG) console.error('[background-worker] unhandled rejection', e);
});
