'use strict';

/**
 * LibreOffice discovery and verification.
 *
 * MorphEra uses LibreOffice as its document conversion engine. Finding the
 * binary reliably is harder than it looks: installs can be per-user, portable,
 * registered in the App Paths registry key, or provided by Homebrew, Snap or
 * Flatpak. This module centralises that logic so the startup gate, Settings
 * page and the conversion engine all agree on the same result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('./libreoffice-runtime');

const DOWNLOAD_URL = 'https://www.libreoffice.org/download/download-libreoffice/';
const EXE = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
const CACHE_TTL = 15 * 1000;
const DEFAULT_VERIFY_TIMEOUT = 10000;

let configuredPath = '';
let cache = { at: 0, path: null };

function isExecutable(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size <= 0) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    // A renamed HTML page or a truncated download must not masquerade as a
    // Windows executable. LibreOffice's launcher is a normal PE file.
    if (process.platform === 'win32' && /\.(exe|com)$/i.test(p)) {
      const fd = fs.openSync(p, 'r');
      try {
        const head = Buffer.alloc(2);
        const read = fs.readSync(fd, head, 0, 2, 0);
        if (read < 2 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function unquote(s) {
  return String(s || '').trim().replace(/^"(.*)"$/, '$1').trim();
}

/**
 * Turns a path chosen by the user into the actual LibreOffice executable.
 * Accepts an executable, an install directory, or (on macOS) an .app bundle.
 */
function resolveUserPath(input) {
  let p = unquote(input);
  if (!p) return '';
  try { p = path.resolve(p); } catch { return ''; }

  const candidates = [];
  try {
    if (fs.statSync(p).isDirectory()) {
      if (process.platform === 'darwin') candidates.push(path.join(p, 'Contents', 'MacOS', 'soffice'));
      candidates.push(path.join(p, 'program', EXE));
      candidates.push(path.join(p, 'program', 'soffice.bin'));
      candidates.push(path.join(p, EXE));
    }
  } catch { /* not a directory */ }

  if (process.platform === 'darwin' && /\.app$/i.test(p)) candidates.push(path.join(p, 'Contents', 'MacOS', 'soffice'));
  if (process.platform === 'win32' && !path.extname(p)) candidates.push(p + '.exe');

  for (const c of candidates) if (isExecutable(c)) return c;
  return p;
}

function knownCandidates() {
  const out = [];
  const add = (p) => { if (p) out.push(p); };

  if (process.platform === 'win32') {
    const bases = [
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
    ].filter(Boolean);

    for (const base of bases) {
      add(path.join(base, 'LibreOffice', 'program', 'soffice.exe'));
      // Versioned / vendor folders such as "LibreOffice 7" or "LibreOffice 24".
      try {
        for (const entry of fs.readdirSync(base)) {
          if (!/^libreoffice/i.test(entry)) continue;
          add(path.join(base, entry, 'program', 'soffice.exe'));
        }
      } catch { /* unreadable folder */ }
    }

    const home = process.env.USERPROFILE || os.homedir();
    add(path.join(home, 'scoop', 'shims', 'soffice.exe'));
    add(path.join(home, 'scoop', 'apps', 'libreoffice', 'current', 'program', 'soffice.exe'));
    add(path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'soffice.exe'));
  } else if (process.platform === 'darwin') {
    const home = os.homedir();
    add('/Applications/LibreOffice.app/Contents/MacOS/soffice');
    add('/Applications/LibreOfficeDev.app/Contents/MacOS/soffice');
    add(path.join(home, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'));
    add('/opt/homebrew/bin/soffice');
    add('/usr/local/bin/soffice');
    add('/opt/local/bin/soffice');
  } else {
    add('/usr/bin/soffice');
    add('/usr/local/bin/soffice');
    add('/usr/lib/libreoffice/program/soffice');
    add('/usr/lib64/libreoffice/program/soffice');
    add('/usr/lib32/libreoffice/program/soffice');
    add('/opt/libreoffice/program/soffice');
    add('/snap/bin/libreoffice');
    add('/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice');
    add(path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libreoffice.LibreOffice'));

    // Vendor builds often live in /opt/libreoffice7.6/program/soffice.
    try {
      for (const entry of fs.readdirSync('/opt')) {
        if (!/^libreoffice/i.test(entry)) continue;
        add(path.join('/opt', entry, 'program', 'soffice'));
      }
    } catch { /* /opt may not exist */ }
  }
  return out;
}

function searchPathEnv() {
  const names = process.platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice'];
  for (const raw of String(process.env.PATH || '').split(path.delimiter)) {
    const dir = unquote(raw);
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function queryRegistry() {
  if (process.platform !== 'win32') return '';
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\soffice.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\soffice.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\soffice.exe',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = String(out).match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
      if (m) {
        const p = resolveUserPath(m[1]);
        if (isExecutable(p)) return p;
      }
    } catch { /* key missing or reg.exe unavailable */ }
  }
  return '';
}

/**
 * Synchronous discovery. Cheap enough for startup and job pre-flight checks.
 * Results are cached briefly so repeated status/polling calls do not hammer
 * the filesystem or the Windows registry.
 */
function findLibreOffice(opts = {}) {
  const custom = resolveUserPath(opts.customPath != null ? opts.customPath : (configuredPath || process.env.MORPH_SOFFICE || ''));
  // An explicitly configured path always wins, but only when it is valid.
  // If it went stale we keep searching the standard locations.
  if (custom && isExecutable(custom)) return custom;

  const now = Date.now();
  if (!opts.force && cache.path && now - cache.at < CACHE_TTL) return cache.path;
  if (!opts.force && !cache.path && now - cache.at < CACHE_TTL) return null;

  let found = null;
  for (const p of knownCandidates()) {
    if (isExecutable(p)) { found = p; break; }
  }
  if (!found) found = searchPathEnv();
  if (!found) found = queryRegistry() || null;

  cache = { at: now, path: found };
  return found;
}

function versionFromOutput(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`.trim();
  if (!text) return 'unknown';
  const m = text.match(/LibreOffice\s+([0-9][0-9.]*)/i);
  // Do not present an unrelated warning (for example the platform-library
  // notice printed on timeout) as the LibreOffice version.
  return m ? m[1] : 'unknown';
}

/** Prefer the console launcher on Windows when it exists: it returns CLI
 * output reliably and exits as soon as `--version` is done. */
function verificationCommand(bin) {
  if (process.platform === 'win32') {
    const com = path.join(path.dirname(bin), 'soffice.com');
    if (isExecutable(com)) return com;
  }
  return bin;
}

function verificationTimeout(opts) {
  const fromEnv = Number(process.env.MORPH_LO_VERIFY_TIMEOUT);
  const wanted = Number(opts && opts.timeoutMs) || fromEnv || DEFAULT_VERIFY_TIMEOUT;
  return Math.max(300, Math.min(60000, wanted));
}

/**
 * Verify that a discovered file really is a working LibreOffice executable.
 *
 * A short `--version` probe is used, but it runs with a private profile and
 * headless flags. If the first probe times out, stale Morphera-owned processes
 * are cleaned and one fresh probe is attempted. If that also times out, the
 * executable still counts as installed: the file exists and is a valid PE /
 * executable, and document jobs will perform their own headless run with a
 * timeout and cleanup. This avoids a false "could not start" gate on a busy
 * machine while still rejecting missing or invalid files.
 */
async function verifyExecutable(bin, opts = {}) {
  if (!isExecutable(bin)) {
    return { ok: false, error: 'LibreOffice was found, but the file is missing or cannot be run.' };
  }

  const timeoutMs = verificationTimeout(opts);
  const command = verificationCommand(bin);
  let last = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Remove orphans that might still hold a profile or a document lock.
    // Active MorphEra conversions are excluded inside the runtime.
    await runtime.killStale();
    const result = await runtime.runCaptured(command, ['--version'], timeoutMs);
    last = result;

    if (result.timedOut) continue;
    if (result.error) {
      const code = result.error.code;
      if (code === 'EACCES') return { ok: false, error: 'MorphEra does not have permission to run LibreOffice.' };
      if (code === 'ENOENT') return { ok: false, error: 'LibreOffice was found, but it could not be started.' };
      return { ok: false, error: (result.error && result.error.message) || 'LibreOffice could not be started.' };
    }

    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const base = path.basename(bin).toLowerCase();
    const knownName = /^soffice(\.(exe|com|bin))?$/.test(base) || /libreoffice/.test(base);

    if (/libreoffice/i.test(text) || knownName) {
      return {
        ok: true,
        verified: true,
        timedOut: false,
        version: versionFromOutput(result.stdout, result.stderr),
      };
    }

    // A non-LibreOffice program was selected. It accepts --version, but its
    // name and output prove it is something else.
    return {
      ok: false,
      error: 'That program does not look like LibreOffice. Choose the soffice program inside the LibreOffice folder.',
    };
  }

  // Existence and executable format were already validated. Treat a repeated
  // launch timeout as "installed but slow" rather than a permanent failure.
  if (last && last.timedOut) {
    return {
      ok: true,
      verified: false,
      timedOut: true,
      version: versionFromOutput(last.stdout, last.stderr),
      warning: 'LibreOffice is installed, but it is taking longer than usual to start. MorphEra will clean up stale processes and retry when it converts a document.',
    };
  }

  return { ok: false, error: 'LibreOffice was found, but it could not be started. Close any open LibreOffice windows and try again.' };
}

function instructions() {
  if (process.platform === 'win32') {
    return [
      'Click “Download LibreOffice”. MorphEra downloads the latest official installer and verifies its signature.',
      'Approve the Windows administrator prompt (UAC); LibreOffice installs silently in the background.',
      'MorphEra verifies the installation automatically and unlocks the workspace.',
      'If LibreOffice is already installed, confirm the clean-reinstall prompt or use “Locate LibreOffice”.',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      'Download the LibreOffice .dmg from libreoffice.org.',
      'Open it and drag LibreOffice into your Applications folder.',
      'Come back to MorphEra and click “Check again”.',
      'If it is in a custom folder, use “Locate LibreOffice”.',
    ];
  }
  return [
    'Install LibreOffice with your package manager, for example: sudo apt install libreoffice',
    'Or download it from libreoffice.org.',
    'Come back to MorphEra and click “Check again”.',
    'If you use Snap, Flatpak or a custom location, use “Locate LibreOffice”.',
  ];
}

function baseStatus(extra) {
  return {
    platform: process.platform,
    arch: process.arch,
    autoInstall: process.platform === 'win32',
    downloadUrl: DOWNLOAD_URL,
    instructions: instructions(),
    checkedAt: Date.now(),
    ...extra,
  };
}

/**
 * Detailed status. With verify=true the executable is actually launched with
 * --version inside a private headless profile, which catches broken or
 * half-removed installations without mistaking a slow start for a fatal error.
 */
async function detect(opts = {}) {
  const bin = findLibreOffice(opts);
  if (!bin) {
    return baseStatus({
      installed: false,
      healthy: false,
      verified: true,
      path: null,
      version: null,
      warning: null,
      error: 'LibreOffice is not installed or could not be found.',
    });
  }
  if (opts.verify === false) {
    return baseStatus({ installed: true, healthy: null, verified: null, path: bin, version: null, warning: null, error: null });
  }
  const result = await verifyExecutable(bin, { timeoutMs: opts.verifyTimeoutMs });
  const ok = !!result.ok;
  return baseStatus({
    installed: true,
    healthy: ok,
    verified: ok ? result.verified !== false : false,
    path: bin,
    version: result.version || null,
    warning: ok ? (result.warning || null) : null,
    error: ok ? null : result.error,
  });
}

/** Quick, non-blocking status used by the startup gate. */
async function status() {
  return detect({ verify: false, force: true });
}

function configure(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'customPath')) {
    configuredPath = resolveUserPath(opts.customPath || '');
    cache = { at: 0, path: null };
  }
}

function invalidate() {
  cache = { at: 0, path: null };
}

module.exports = {
  DOWNLOAD_URL,
  findLibreOffice,
  detect,
  status,
  configure,
  invalidate,
  resolveUserPath,
  isExecutable,
  instructions,
  verifyExecutable,
};
