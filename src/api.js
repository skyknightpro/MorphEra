// Thin wrapper over the bridge exposed by the desktop shell.
export const api = window.morph;

/**
 * Turns an IPC rejection into the short sentence the user should see.
 * Electron prefixes remote errors with `Error invoking remote method 'x': Error: `
 * which is noise in the UI.
 */
export const errorText = (e, fallback = 'Something went wrong.') => String((e && e.message) || e || fallback)
  .replace(/^Error invoking remote method '[^']+':\s*/, '')
  .replace(/^Error:\s*/, '')
  .trim() || fallback;

export const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

export const fmtTime = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};

export const fmtDuration = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// "200 KB", "1.5mb", "300" (KB) -> bytes
export const parseSize = (txt, unit) => {
  const m = String(txt).trim().toLowerCase().match(/^([\d.,]+)\s*(kb|mb|b)?$/);
  if (!m) return 0;
  const v = parseFloat(m[1].replace(',', '.'));
  if (!(v > 0)) return 0;
  const u = m[2] || unit || 'kb';
  return Math.round(v * (u === 'mb' ? 1024 * 1024 : u === 'kb' ? 1024 : 1));
};

export const extLabel = (e) => String(e || '').toUpperCase();
