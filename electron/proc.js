'use strict';

/**
 * Small process helpers shared by the media, OCR and LibreOffice engines.
 * Keeping the platform-specific teardown in one place makes cancellation
 * predictable: child tree first, then a hard fallback.
 */

const { spawn } = require('child_process');

function killTree(child, signal = 'SIGKILL') {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      // FFmpeg and soffice both spawn helper processes. taskkill /T makes sure
      // none of them keep running after the user cancels.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { /* fall through to child.kill */ });
      try { child.kill(); } catch { /* ignore */ }
    } else {
      try { child.kill(signal); } catch { /* ignore */ }
    }
  } catch {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

/**
 * Reject if `promise` does not settle in time. The original operation cannot
 * be cancelled generically, so callers pass `onTimeout` to terminate/cleanup.
 */
function withTimeout(promise, ms, message, onTimeout) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch { /* ignore */ }
      reject(new Error(message || 'The operation took too long.'));
    }, Math.max(1, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

module.exports = { killTree, withTimeout };
