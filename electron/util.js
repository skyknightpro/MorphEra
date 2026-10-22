'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const state = {
  outputDir: () => path.join(process.cwd(), 'output'),
  tmpRoot: path.join(os.tmpdir(), 'MorphEra'),
  dataDir: path.join(os.tmpdir(), 'morphera-data'),
  libreOfficePath: '',
};

function configure(o) { Object.assign(state, o); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function getState() { return state; }

class Cancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'Cancelled'; this.cancelled = true; }
}
function checkAbort(ctx) { if (ctx && ctx.signal && ctx.signal.aborted) throw new Cancelled(); }

function safeName(s) { return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'file'; }

function baseName(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; }
function extOf(p) { return path.extname(p).replace(/^\./, '').toLowerCase(); }

function uniquePath(dir, base, ext) {
  ensureDir(dir);
  const e = ext ? '.' + ext : '';
  let p = path.join(dir, safeName(base) + e);
  let n = 1;
  while (fs.existsSync(p)) { p = path.join(dir, `${safeName(base)} (${n})${e}`); n++; }
  return p;
}

// Output path for a converted file. `subdir` is used when a job creates many files.
function outPath(ctx, inputPath, ext, opts = {}) {
  const dir = opts.subdir ? path.join(ctx.outDir, safeName(opts.subdir)) : ctx.outDir;
  const base = (opts.base || baseName(inputPath)) + (opts.suffix || '');
  return uniquePath(dir, base, ext);
}

function outFolder(ctx, name) {
  const p = uniquePath(ctx.outDir, name, '');
  ensureDir(p);
  return p;
}

function tmpFile(ext, prefix = 'tmp') {
  ensureDir(state.tmpRoot);
  return path.join(state.tmpRoot, `${prefix}-${crypto.randomBytes(5).toString('hex')}${ext ? '.' + ext : ''}`);
}
function tmpDir(prefix = 'dir') {
  const d = path.join(state.tmpRoot, `${prefix}-${crypto.randomBytes(5).toString('hex')}`);
  return ensureDir(d);
}
function rmQuiet(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function resolveBin(kind) {
  const envKey = kind === 'ffmpeg' ? 'MORPH_FFMPEG' : 'MORPH_FFPROBE';
  if (process.env[envKey]) return process.env[envKey];
  try {
    if (kind === 'ffmpeg') {
      const p = require('ffmpeg-static');
      if (p && fs.existsSync(p)) return p;
    } else {
      const p = require('ffprobe-static').path;
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* fall through to PATH */ }
  return kind; // rely on PATH
}

function findLibreOffice(opts = {}) {
  // The real detection logic lives in libreoffice.js (registry, PATH, Snap,
  // Flatpak, per-user installs, custom path). Keep this wrapper for callers
  // that only need the path.
  try {
    return require('./libreoffice').findLibreOffice({
      ...opts,
      customPath: opts.customPath !== undefined ? opts.customPath : (state.libreOfficePath || undefined),
    });
  } catch {
    return null;
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

module.exports = {
  configure, getState, ensureDir, Cancelled, checkAbort, safeName, baseName, extOf, uniquePath, outPath, outFolder,
  tmpFile, tmpDir, rmQuiet, fileSize, resolveBin, findLibreOffice, formatBytes,
};
