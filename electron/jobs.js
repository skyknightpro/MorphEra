'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const F = require('./formats');

const image = require('./engines/image');
const media = require('./engines/media');
const pdf = require('./engines/pdf');
const docs = require('./engines/docs');

function applyPreset(job) {
  if (!job.preset) return job;
  const p = F.PRESETS[job.preset];
  if (!p) return job;
  const cat = F.categoryOf(U.extOf(job.file || (job.files && job.files[0]) || ''));
  const j = { ...job, opts: { ...(job.opts || {}) }, edits: { ...(job.edits || {}) } };
  if (cat === 'image' && p.image) {
    const c = p.image;
    j.to = j.to || c.to;
    if (c.quality) j.opts.quality = c.quality;
    if (c.maxBytes) j.opts.maxBytes = c.maxBytes;
    if (c.density) j.opts.density = c.density;
    if (c.maxEdge) j.edits.resize = { mode: 'maxEdge', maxEdge: c.maxEdge };
    if (c.width && c.height) j.edits.resize = { mode: 'exact', width: c.width, height: c.height, fit: c.fit || 'cover' };
    j.opts.stripMeta = true;
  } else if (cat === 'video' && p.video) {
    const c = p.video;
    j.to = c.to;
    Object.assign(j.opts, { height: c.height, crf: c.crf, audioBitrate: c.audioBitrate });
    if (c.maxBytes) j.opts.maxBytes = c.maxBytes;
  } else if (cat === 'audio' && p.audio) {
    j.to = p.audio.to;
    j.opts.audioBitrate = p.audio.audioBitrate;
  } else if (cat === 'document' && U.extOf(job.file) === 'pdf' && p.pdf) {
    j.kind = 'compress';
    j.opts.targetBytes = 0;
    j.opts.maxBytes = p.pdf.maxBytes;
  }
  return j;
}

function missingFile(p) {
  try { return !fs.statSync(p).isFile(); } catch { return true; }
}

async function runJob(ctx, job) {
  if (!job || typeof job !== 'object') throw new Error('No conversion was requested.');
  job = applyPreset(job);
  const file = job.file;
  const o = job.opts || {};
  const inputs = Array.isArray(job.files) && job.files.length ? job.files : (file ? [file] : []);
  if (!inputs.length) throw new Error('No file was provided.');
  const missing = inputs.find(missingFile);
  if (missing) throw new Error(`The file “${path.basename(missing)}” could not be found. It may have been moved or deleted.`);
  switch (job.kind) {
    case 'convert': {
      const ext = F.norm(U.extOf(file));
      const cat = F.categoryOf(ext);
      const to = F.norm(job.to);
      if (cat === 'image') {
        if (['mp4', 'webm'].includes(to)) return media.convertMedia(ctx, { file, to, opts: o });
        return image.processImage(ctx, { file, to, edits: job.edits, opts: o });
      }
      if (cat === 'video' || cat === 'audio') return media.convertMedia(ctx, { file, to, opts: o });
      if (cat === 'document') return docs.convertDocument(ctx, { file, to, opts: o });
      throw new Error('This file type is not supported.');
    }
    case 'compress': {
      const ext = F.norm(U.extOf(file));
      const cat = F.categoryOf(ext);
      const opts = { ...o, targetBytes: o.targetBytes || 0 };
      if (cat === 'image') return image.processImage(ctx, { file, to: F.norm(job.to || (ext === 'gif' ? 'webp' : ext)), edits: job.edits, opts });
      if (cat === 'video' || cat === 'audio') return media.convertMedia(ctx, { file, to: F.norm(job.to || (cat === 'video' ? 'mp4' : ext === 'wav' || ext === 'flac' ? 'mp3' : ext)), opts: { ...opts, suffix: ' (compressed)' } });
      if (ext === 'pdf') return pdf.compressPdf(ctx, { file, targetBytes: opts.targetBytes || opts.maxBytes, level: o.level, password: o.password });
      throw new Error('This file type cannot be compressed.');
    }
    case 'edit-image': return image.processImage(ctx, { file, to: job.to || F.norm(U.extOf(file)), edits: job.edits, opts: o });
    case 'merge-pdf': return pdf.mergePdfs(ctx, { files: job.files, password: o.password });
    case 'split-pdf': return pdf.splitPdf(ctx, { file, ...job.split, password: o.password });
    case 'arrange-pdf': return pdf.arrangePdf(ctx, { file, order: job.order, password: o.password });
    case 'watermark-pdf': return pdf.watermarkPdf(ctx, { file, wm: job.watermark, password: o.password });
    case 'lock-pdf': return pdf.lockPdf(ctx, { file, password: o.newPassword });
    case 'unlock-pdf': return pdf.unlockPdf(ctx, { file, password: o.password });
    case 'pdf-to-images': return pdf.pdfToImages(ctx, { file, format: job.to || 'png', dpi: o.dpi || 200, quality: o.quality || 90, password: o.password });
    case 'images-to-pdf': return pdf.imagesToPdf(ctx, { files: job.files });
    case 'merge-media': return media.mergeMedia(ctx, { files: job.files, to: job.to });
    case 'extract-audio': return media.convertMedia(ctx, { file, to: F.norm(job.to || 'mp3'), opts: o });
    default: throw new Error(`Unknown job type: ${job.kind}`);
  }
}

function friendly(e) {
  const raw = String((e && e.message) || e || 'Something went wrong');
  if (e && e.cancelled) return 'Cancelled';
  if (/ENOENT/.test(raw)) return 'The file could not be found. It may have been moved or deleted.';
  if (/EACCES|EPERM/.test(raw)) return 'MorphEra does not have permission to read or write there. Choose another output folder in Settings.';
  if (/EBUSY/.test(raw)) return 'The file is open in another program. Close it and try again.';
  if (/ENOSPC/.test(raw)) return 'The disk is full. Free some space and try again.';
  if (/ENOMEM|out of memory|allocation failed/i.test(raw)) return 'There was not enough memory to finish. Close other apps or try a smaller file.';
  if (/Input buffer contains unsupported image format|unsupported image format/i.test(raw)) return 'This image could not be read. It may be damaged or in an unsupported format.';
  if (/LibreOffice/i.test(raw) && /not|missing|could not|failed|install/i.test(raw)) {
    return /install/i.test(raw) ? raw : 'LibreOffice could not complete this conversion. Close any open LibreOffice windows and try again.';
  }
  if (/password|encrypt|locked/i.test(raw) && /pdf/i.test(raw)) return 'This PDF is locked. Unlock it first with PDF Tools.';
  if (/Invalid PDF|PDF.*corrupt|XRef|trailer/i.test(raw)) return 'This PDF could not be read. It may be damaged.';
  if (/page engine|worker/i.test(raw) && /not|stopped|start|respond/i.test(raw)) return 'The PDF engine restarted unexpectedly. Please try again.';
  if (/background removal engine|background removal/i.test(raw)) return raw;
  if (/FFmpeg|ffmpeg/i.test(raw) && /not found|ENOENT/i.test(raw)) return 'The media engine is missing. Reinstall MorphEra to restore it.';
  if (/timed out|took too long|timeout/i.test(raw)) return 'This took too long and was stopped. Try a smaller file.';
  return raw.length > 260 ? raw.slice(0, 260) + '…' : raw;
}

function verifyOutputs(res) {
  const outs = (res && res.outputs) || [];
  if (!outs.length) throw new Error('The conversion finished without producing a file.');
  for (const p of outs) {
    const size = U.fileSize(p);
    if (!size) throw new Error('The conversion produced an empty file. Try different settings.');
  }
  return outs;
}

class Queue {
  constructor({ getOutDir, services, onUpdate, onIdle }) {
    this.getOutDir = getOutDir;
    this.services = services;
    this.onUpdate = onUpdate;
    this.onIdle = onIdle;
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.max = 2;
    this.batchDone = 0;
  }
  add(spec) {
    if (!spec || typeof spec !== 'object' || !spec.kind) throw new Error('That conversion request is not valid.');
    const id = spec.id || 'j' + Math.random().toString(36).slice(2, 10);
    const job = { id, spec: { ...spec, id }, status: 'queued', progress: 0, label: 'Waiting', outputs: [], error: null, ac: new AbortController(), added: Date.now() };
    this.jobs.set(id, job);
    this.pending.push(id);
    this.emit(job);
    this.pump();
    return id;
  }
  emit(job) {
    this.onUpdate({ id: job.id, status: job.status, progress: job.progress, label: job.label, outputs: job.outputs, error: job.error, note: job.note, outDir: job.outDir, elapsed: job.elapsed, sizeOut: (job.outputs || []).reduce((a, p) => a + U.fileSize(p), 0) });
  }
  heavy(spec) {
    const cat = spec.kind === 'convert' || spec.kind === 'compress' ? F.categoryOf(U.extOf(spec.file || '')) : null;
    return cat === 'video'
      || spec.kind === 'merge-media'
      || (cat === 'document' && U.extOf(spec.file) === 'pdf')
      || !!(spec.edits && spec.edits.removeBg);
  }
  pump() {
    while (this.pending.length) {
      const id = this.pending[0];
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') { this.pending.shift(); continue; }
      const heavy = this.heavy(job.spec);
      const limit = heavy ? 1 : this.max;
      const heavyRunning = [...this.jobs.values()].filter((j) => j.status === 'running' && this.heavy(j.spec)).length;
      if (this.running >= this.max || (heavy && heavyRunning >= limit)) {
        // try to find a lighter job to run while heavy ones wait
        const idx = this.pending.findIndex((pid) => { const j = this.jobs.get(pid); return j && j.status === 'queued' && !this.heavy(j.spec); });
        if (idx > 0 && this.running < this.max) { const [x] = this.pending.splice(idx, 1); this.pending.unshift(x); continue; }
        return;
      }
      this.pending.shift();
      this.run(job);
    }
  }
  async run(job) {
    this.running++;
    job.status = 'running';
    job.label = 'Starting';
    job.started = Date.now();
    this.emit(job);
    let last = 0;
    const ctx = {
      signal: job.ac.signal,
      outDir: job.spec.outDir || this.getOutDir(),
      services: this.services,
      progress: (p, label) => {
        const now = Date.now();
        job.progress = Math.max(job.progress, Math.min(0.995, p));
        if (label) job.label = label;
        if (now - last > 90) { last = now; this.emit(job); }
      },
    };
    job.outDir = ctx.outDir;
    try {
      U.ensureDir(ctx.outDir);
      const res = await runJob(ctx, job.spec);
      job.outputs = verifyOutputs(res);
      job.folder = res.folder;
      job.note = res.note;
      job.status = 'done';
      job.progress = 1;
      job.label = 'Done';
      this.batchDone++;
    } catch (e) {
      if (e && (e.cancelled || job.ac.signal.aborted)) { job.status = 'cancelled'; job.label = 'Cancelled'; }
      else { job.status = 'error'; job.error = friendly(e); job.label = 'Failed'; if (process.env.MORPH_DEBUG) console.error(e); }
    }
    job.elapsed = Date.now() - job.started;
    this.running--;
    this.emit(job);
    this.pump();
    if (!this.running && !this.pending.length) { const n = this.batchDone; this.batchDone = 0; if (n) this.onIdle(n); }
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status === 'queued') {
      this.pending = this.pending.filter((pid) => pid !== id);
      job.status = 'cancelled';
      job.label = 'Cancelled';
      job.progress = 0;
      this.emit(job);
    } else if (job.status === 'running') {
      job.ac.abort();
    }
  }
  cancelAll() {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
    this.pending = [];
  }
  clearFinished() {
    const removed = [];
    for (const [id, job] of this.jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      this.jobs.delete(id);
      removed.push(id);
    }
    return removed;
  }
}

module.exports = { Queue, runJob, applyPreset, friendly };
