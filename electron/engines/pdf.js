'use strict';
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');
const U = require('../util');

const PT = 72;
// Whole-document operations allocate per page in memory. These caps keep a
// pathological PDF from exhausting RAM while still allowing realistic files.
const MAX_PAGES = 5000;
const MAX_MERGE_FILES = 200;
const MAX_SPLIT_OUTPUTS = 2000;

function worker(ctx) {
  if (!ctx.services || !ctx.services.worker) throw new Error('The page engine is not available.');
  return (fn, ...a) => ctx.services.worker.call(fn, a);
}

function inputPdf(file) {
  let st;
  try { st = fs.statSync(file); } catch { throw new Error('This PDF could not be found. It may have been moved or deleted.'); }
  if (!st.isFile()) throw new Error('That path is not a PDF file.');
  if (!st.size) throw new Error('This PDF is empty.');
  return st.size;
}

function readPdf(file) {
  inputPdf(file);
  try { return fs.readFileSync(file); } catch { throw new Error('This PDF could not be read. Check that you can open it, then try again.'); }
}

/** Rejects a silently-empty result and removes the half-written file. */
function verifyOutput(dest) {
  const size = U.fileSize(dest);
  if (!size) {
    U.rmQuiet(dest);
    throw new Error('The result came out empty. Try different settings.');
  }
  return dest;
}

function writePdf(dest, bytes, what = 'PDF') {
  if (!bytes || !bytes.length) throw new Error(`The ${what} could not be created. Try different settings.`);
  try { fs.writeFileSync(dest, bytes); } catch (e) {
    U.rmQuiet(dest);
    if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM')) throw e;
    throw new Error(`The ${what} could not be saved. Check the output folder and try again.`);
  }
  return verifyOutput(dest);
}

function cleanPassword(p) {
  return p == null ? '' : String(p);
}

function parseRanges(spec, total) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      if (a < 1 || b > total || a > b) throw new Error(`Page range "${s}" is outside 1–${total}.`);
      const r = []; for (let i = a; i <= b; i++) r.push(i - 1); out.push(r);
    } else if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n < 1 || n > total) throw new Error(`Page ${n} is outside 1–${total}.`);
      out.push([n - 1]);
    } else throw new Error(`Could not read "${s}". Use something like 1-3, 5, 8-.`);
  }
  return out;
}

async function load(file, password) {
  const bytes = readPdf(file);
  const pass = cleanPassword(password);
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    if (/encrypt|password/i.test((e && e.message) || '')) {
      if (!pass) throw new Error('This PDF is locked. Unlock it first (PDF Tools → Unlock).');
      let buf;
      try { buf = await mupdfTransform(bytes, 'decrypt', pass); } catch (err) {
        if (/wrong password/i.test((err && err.message) || '')) throw err;
        throw new Error('This PDF could not be unlocked. Check the password and try again.');
      }
      try {
        return await PDFDocument.load(buf, { updateMetadata: false });
      } catch {
        throw new Error('Wrong password, or this PDF uses protection MorphEra cannot remove.');
      }
    }
    throw new Error('This PDF could not be read. It may be damaged or use an unsupported format.');
  }
}

/* ---------------------------------------------------------------- mupdf */

async function mupdfTransform(bytes, mode, password, newPassword) {
  let mupdf;
  try { mupdf = await import('mupdf'); } catch { throw new Error('The PDF security engine is not installed. Reinstall MorphEra to restore it.'); }
  if (!bytes || !bytes.length) throw new Error('This PDF is empty.');
  let doc;
  try {
    doc = mupdf.PDFDocument.openDocument(Buffer.from(bytes), 'application/pdf');
  } catch {
    throw new Error('This PDF could not be opened. It may be damaged.');
  }
  try {
    if (doc.needsPassword()) {
      if (!doc.authenticatePassword(cleanPassword(password))) throw new Error('Wrong password.');
    }
    let opts;
    if (mode === 'decrypt') opts = 'encrypt=none,garbage=compact';
    else if (mode === 'encrypt') {
      if (!newPassword) throw new Error('Type a password first.');
      opts = `encrypt=aes-256,user-password=${newPassword},owner-password=${newPassword}_owner,garbage=compact`;
    } else opts = 'garbage=deduplicate,compress,clean';
    const out = doc.saveToBuffer(opts);
    const arr = out.asUint8Array ? out.asUint8Array() : out.getBuffer ? out.getBuffer() : out;
    const buf = Buffer.from(arr);
    if (!buf.length) throw new Error('The PDF engine returned an empty result. Try again.');
    return buf;
  } finally {
    // Native documents hold pages/fonts until explicitly closed.
    try { doc.destroy(); } catch { /* best effort */ }
  }
}

async function lockPdf(ctx, { file, password }) {
  inputPdf(file);
  const pass = cleanPassword(password);
  if (!pass) throw new Error('Type a password first.');
  if (pass.length > 128) throw new Error('Use a password of 128 characters or fewer.');
  ctx.progress(0.3, 'Encrypting');
  const out = await mupdfTransform(readPdf(file), 'encrypt', '', pass);
  const dest = U.outPath(ctx, file, 'pdf', { suffix: ' (locked)' });
  writePdf(dest, out, 'locked PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

async function unlockPdf(ctx, { file, password }) {
  inputPdf(file);
  ctx.progress(0.3, 'Unlocking');
  const out = await mupdfTransform(readPdf(file), 'decrypt', cleanPassword(password));
  const dest = U.outPath(ctx, file, 'pdf', { suffix: ' (unlocked)' });
  writePdf(dest, out, 'unlocked PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

/* ---------------------------------------------------------- images -> PDF */

async function imagesToPdfFile(ctx, files, dest, o = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Add at least one image.');
  const pdf = await PDFDocument.create();
  pdf.setCreator('MorphEra');
  const A4 = [595.28, 841.89];
  for (let i = 0; i < files.length; i++) {
    U.checkAbort(ctx);
    const image = require('./image');
    const input = await image.loadInput(ctx, files[i]);
    let buf;
    try {
      buf = await sharp(input.buf, { failOn: 'none', limitInputPixels: false }).rotate().toBuffer();
    } catch {
      throw new Error(`Page ${i + 1}: this image could not be read.`);
    }
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error(`Page ${i + 1}: this image could not be read.`);
    if (meta.width * meta.height > 250 * 1000 * 1000) throw new Error(`Page ${i + 1}: this image is too large to place in a PDF.`);
    const hasAlpha = !!meta.hasAlpha;
    let emb;
    try {
      if (!hasAlpha && meta.format === 'jpeg') emb = await pdf.embedJpg(buf);
      else if (!hasAlpha) emb = await pdf.embedJpg(await sharp(buf).jpeg({ quality: 92 }).toBuffer());
      else emb = await pdf.embedPng(await sharp(buf).png().toBuffer());
    } catch {
      throw new Error(`Page ${i + 1}: this image could not be added to the PDF.`);
    }
    if (!emb.width || !emb.height) throw new Error(`Page ${i + 1}: this image has no usable pixels.`);
    let pw, ph;
    if (o.fit === 'image') { pw = emb.width * PT / 96; ph = emb.height * PT / 96; }
    else {
      const land = emb.width > emb.height;
      [pw, ph] = land ? [A4[1], A4[0]] : A4;
    }
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) throw new Error(`Page ${i + 1}: this image has an invalid size.`);
    const page = pdf.addPage([pw, ph]);
    const margin = o.fit === 'image' ? 0 : 24;
    const s = Math.min((pw - margin * 2) / emb.width, (ph - margin * 2) / emb.height);
    const w = emb.width * s, h = emb.height * s;
    page.drawImage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    ctx.progress((i + 1) / files.length * 0.9);
  }
  writePdf(dest, await pdf.save());
}

async function imagesToPdf(ctx, { files, base }) {
  if (!Array.isArray(files) || !files.length) throw new Error('Add at least one image.');
  if (files.length > 500) throw new Error('Add up to 500 images at a time.');
  const dest = U.outPath(ctx, files[0], 'pdf', { base: base || (files.length > 1 ? 'Images' : undefined) });
  await imagesToPdfFile(ctx, files, dest, {});
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

/* ---------------------------------------------------------- PDF -> images */

async function pdfToImages(ctx, { file, format = 'png', dpi = 200, quality = 90, password, baseName }) {
  inputPdf(file);
  const fmt = ['png', 'jpg', 'jpeg'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'png';
  const scale = Math.max(0.1, Math.min(10, (Number(dpi) || 200) / 72));
  const q = Math.max(30, Math.min(100, Number(quality) || 90));
  const call = worker(ctx);
  const docId = 'i' + Math.random().toString(36).slice(2);
  let pages;
  try {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { throw new Error('This PDF could not be read. It may have been moved or deleted.'); }
    pages = (await call('openDoc', docId, bytes, cleanPassword(password))).pages;
  } catch (e) {
    throw new Error(/password|encrypt/i.test((e && e.message) || '') ? 'This PDF is locked. Unlock it first.' : ((e && e.message) || 'This PDF could not be opened.'));
  }
  if (!pages) throw new Error('This PDF has no pages.');
  if (pages > MAX_PAGES) throw new Error(`This PDF has too many pages (${pages}). Split it first, then convert the parts.`);
  const base = baseName || U.baseName(file);
  const dir = U.outFolder(ctx, `${base} (pages)`);
  const outs = [];
  try {
    for (let n = 1; n <= pages; n++) {
      U.checkAbort(ctx);
      const r = await call('renderPage', docId, n, { scale, format: fmt === 'jpg' || fmt === 'jpeg' ? 'jpeg' : 'png', quality: q });
      const bytes = Buffer.from(r.bytes || []);
      if (!bytes.length) throw new Error(`Page ${n} rendered empty. Try a lower DPI.`);
      const ext = fmt === 'jpeg' ? 'jpg' : fmt;
      const p = U.uniquePath(dir, `${base} - page ${String(n).padStart(String(pages).length, '0')}`, ext);
      try { fs.writeFileSync(p, bytes); } catch (e) {
        U.rmQuiet(p);
        if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM')) throw e;
        throw new Error(`Page ${n} could not be saved. Check the output folder and try again.`);
      }
      verifyOutput(p);
      outs.push(p);
      ctx.progress(n / pages * 0.97, `Page ${n} of ${pages}`);
    }
  } catch (e) {
    // Do not leave an empty folder behind when nothing could be rendered.
    if (!outs.length) U.rmQuiet(dir);
    throw e;
  } finally { try { await call('closeDoc', docId); } catch { /* ignore */ } }
  if (!outs.length) throw new Error('No pages could be rendered from this PDF.');
  return { outputs: outs, folder: dir };
}

/* ------------------------------------------------------------- page tools */

async function pdfInfo(ctx, { file, password }) {
  try {
    const doc = await load(file, password);
    return { pages: doc.getPageCount(), size: U.fileSize(file), locked: false };
  } catch (e) {
    if (/locked/i.test(e.message)) return { pages: 0, size: U.fileSize(file), locked: true };
    throw e;
  }
}

async function thumbnails(ctx, { file, pages, password, maxEdge = 200 }) {
  inputPdf(file);
  const call = worker(ctx);
  const docId = 't' + Math.random().toString(36).slice(2);
  let info;
  try {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { throw new Error('This PDF could not be read. It may have been moved or deleted.'); }
    info = await call('openDoc', docId, bytes, cleanPassword(password));
  } catch (e) {
    throw new Error(/password|encrypt/i.test((e && e.message) || '') ? 'This PDF is locked. Unlock it first.' : ((e && e.message) || 'This PDF could not be opened.'));
  }
  const total = Math.max(0, Number(info && info.pages) || 0);
  if (!total) {
    try { await call('closeDoc', docId); } catch { /* ignore */ }
    throw new Error('This PDF has no pages.');
  }
  try {
    let list;
    if (Array.isArray(pages) && pages.length) {
      list = Array.from(new Set(pages
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= total)))
        .slice(0, 300)
        .sort((a, b) => a - b);
      if (!list.length) throw new Error('Those pages are outside this PDF.');
    } else {
      list = Array.from({ length: Math.min(total, 200) }, (_, i) => i + 1);
    }
    const edge = Math.max(60, Math.min(600, Number(maxEdge) || 200));
    const th = await call('thumbnails', docId, list, edge);
    if (!Array.isArray(th) || !th.length) throw new Error('No page previews could be created for this PDF.');
    return { total, thumbs: th };
  } finally { try { await call('closeDoc', docId); } catch { /* ignore */ } }
}

async function mergePdfs(ctx, { files, password }) {
  if (!Array.isArray(files) || files.length < 2) throw new Error('Add at least two PDFs to merge.');
  if (files.length > MAX_MERGE_FILES) throw new Error(`Merge up to ${MAX_MERGE_FILES} PDFs at a time.`);
  const out = await PDFDocument.create();
  out.setCreator('MorphEra');
  for (let i = 0; i < files.length; i++) {
    U.checkAbort(ctx);
    const src = await load(files[i], password);
    if (src.getPageCount() > MAX_PAGES) throw new Error(`“${U.baseName(files[i])}” has too many pages to merge.`);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    ctx.progress((i + 1) / files.length * 0.9, `Merging ${i + 1} of ${files.length}`);
  }
  const dest = U.outPath(ctx, files[0], 'pdf', { base: 'Merged', suffix: '' });
  writePdf(dest, await out.save(), 'merged PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

// order: array of { index (0-based), rotate (deg) } = the final page order. Deleted pages are omitted.
async function arrangePdf(ctx, { file, order, password }) {
  const src = await load(file, password);
  const total = src.getPageCount();
  if (!Array.isArray(order) || !order.length) throw new Error('Keep at least one page.');
  if (order.length > total) throw new Error('The page order does not match this PDF.');
  const clean = order.map((o) => {
    const index = Number(o && o.index);
    if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error('The page order does not match this PDF. Reopen it and try again.');
    const r = Number(o && o.rotate);
    return { index, rotate: Number.isFinite(r) ? ((r % 360) + 360) % 360 : 0 };
  });
  const out = await PDFDocument.create();
  out.setCreator('MorphEra');
  const copies = await out.copyPages(src, clean.map((o) => o.index));
  copies.forEach((p, i) => {
    if (clean[i].rotate) p.setRotation(degrees((p.getRotation().angle + clean[i].rotate) % 360));
    out.addPage(p);
  });
  const dest = U.outPath(ctx, file, 'pdf', { suffix: ' (edited)' });
  writePdf(dest, await out.save(), 'edited PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

// mode: 'ranges' | 'every' | 'each'
async function splitPdf(ctx, { file, mode = 'each', ranges, every = 1, password }) {
  const src = await load(file, password);
  const total = src.getPageCount();
  if (!total) throw new Error('This PDF has no pages.');
  if (total > MAX_PAGES) throw new Error(`This PDF has too many pages (${total}). Split it in smaller steps.`);
  let groups;
  if (mode === 'ranges') {
    if (!String(ranges || '').trim()) throw new Error('Type the page ranges to keep, for example 1-3, 5.');
    groups = parseRanges(ranges, total);
  } else if (mode === 'every') {
    const k = Math.max(1, Math.min(total, Number(every) | 0 || 1));
    groups = [];
    for (let i = 0; i < total; i += k) groups.push(Array.from({ length: Math.min(k, total - i) }, (_, j) => i + j));
  } else if (mode === 'each') {
    groups = Array.from({ length: total }, (_, i) => [i]);
  } else throw new Error('Unknown split mode.');

  if (!groups.length) throw new Error('Nothing to split.');
  if (groups.length > MAX_SPLIT_OUTPUTS) throw new Error(`This would create ${groups.length} files. Split into smaller steps.`);
  const dir = U.outFolder(ctx, `${U.baseName(file)} (split)`);
  const outs = [];
  try {
    for (let g = 0; g < groups.length; g++) {
      U.checkAbort(ctx);
      const out = await PDFDocument.create();
      (await out.copyPages(src, groups[g])).forEach((p) => out.addPage(p));
      const label = groups[g].length === 1 ? `page ${groups[g][0] + 1}` : `pages ${groups[g][0] + 1}-${groups[g][groups[g].length - 1] + 1}`;
      const p = U.uniquePath(dir, `${U.baseName(file)} - ${label}`, 'pdf');
      writePdf(p, await out.save(), 'split PDF');
      outs.push(p);
      ctx.progress((g + 1) / groups.length * 0.95, `Saving ${g + 1} of ${groups.length}`);
    }
  } catch (e) {
    if (!outs.length) U.rmQuiet(dir);
    throw e;
  }
  return { outputs: outs, folder: dir };
}

async function watermarkPdf(ctx, { file, wm, password }) {
  inputPdf(file);
  const W = wm || {};
  if (W.type !== 'image' && W.type !== 'text') throw new Error('Choose a text or image watermark.');
  const doc = await load(file, password);
  const call = ctx.services && ctx.services.renderText;
  const pages = doc.getPages();
  if (!pages.length) throw new Error('This PDF has no pages.');
  if (pages.length > MAX_PAGES) throw new Error(`This PDF has too many pages (${pages.length}) for a watermark.`);
  let embText = null, embImg = null;
  const opacity = Math.max(0.05, Math.min(1, (W.opacity == null ? 40 : Number(W.opacity) || 0) / 100));
  const size = Math.max(5, Math.min(100, Number(W.size) || 40)) / 100;
  if (W.type === 'image') {
    if (!W.imagePath) throw new Error('Choose a watermark image first.');
    let st;
    try { st = fs.statSync(W.imagePath); } catch { throw new Error('The watermark image could not be found.'); }
    if (!st.isFile() || !st.size) throw new Error('The watermark image is empty.');
    let png;
    try { png = await sharp(W.imagePath, { failOn: 'none' }).png().toBuffer(); } catch { throw new Error('The watermark image could not be read.'); }
    if (!png.length) throw new Error('The watermark image could not be read.');
    embImg = await doc.embedPng(png);
  } else {
    const text = String(W.text || '').trim();
    if (!text) throw new Error('Type the watermark text first.');
    if (text.length > 1000) throw new Error('Keep the watermark text under 1000 characters.');
    if (!call) throw new Error('The text engine is not available.');
    let png;
    try { png = await call({ text, fontSize: 96, color: W.color || '#888888', shadow: false }); } catch (e) {
      throw new Error((e && e.message) || 'The watermark text could not be rendered.');
    }
    const buf = Buffer.from(png || []);
    if (!buf.length) throw new Error('The watermark text could not be rendered.');
    embText = await doc.embedPng(buf);
  }
  const emb = embImg || embText;
  if (!emb || !emb.width || !emb.height) throw new Error('The watermark image has no usable pixels.');
  const pos = W.position || 'center';
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    const w = width * size * (W.type === 'image' ? 1 : 1.4);
    const h = w * emb.height / emb.width;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) throw new Error('The watermark is too large for this page.');
    const m = 24;
    let x = (width - w) / 2, y = (height - h) / 2;
    if (pos.includes('l')) x = m; if (pos.includes('r')) x = width - w - m;
    if (pos.includes('t')) y = height - h - m; if (pos.includes('b')) y = m;
    const rot = W.rotate != null && Number.isFinite(Number(W.rotate)) ? Number(W.rotate) : (pos === 'center' ? 35 : 0);
    if (pos === 'tile') {
      const stepX = w * 1.8, stepY = h * 3;
      for (let yy = 0; yy < height; yy += stepY) for (let xx = 0; xx < width; xx += stepX) page.drawImage(emb, { x: xx, y: yy, width: w, height: h, opacity, rotate: degrees(rot) });
    } else {
      page.drawImage(emb, { x, y, width: w, height: h, opacity, rotate: degrees(rot) });
    }
    ctx.progress((i + 1) / pages.length * 0.9);
  });
  const dest = U.outPath(ctx, file, 'pdf', { suffix: ' (watermarked)' });
  writePdf(dest, await doc.save(), 'watermarked PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

/* ------------------------------------------------------------ compression */

async function rasterRebuild(ctx, file, scale, quality, password) {
  inputPdf(file);
  const call = worker(ctx);
  const docId = 'c' + Math.random().toString(36).slice(2);
  let info;
  try {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { throw new Error('This PDF could not be read. It may have been moved or deleted.'); }
    info = await call('openDoc', docId, bytes, cleanPassword(password));
  } catch (e) {
    throw new Error(/password|encrypt/i.test((e && e.message) || '') ? 'This PDF is locked. Unlock it first.' : ((e && e.message) || 'This PDF could not be opened.'));
  }
  const pages = Math.max(0, Number(info && info.pages) || 0);
  if (!pages) {
    try { await call('closeDoc', docId); } catch { /* ignore */ }
    throw new Error('This PDF has no pages.');
  }
  if (pages > MAX_PAGES) {
    try { await call('closeDoc', docId); } catch { /* ignore */ }
    throw new Error(`This PDF has too many pages (${pages}) to compress in one step.`);
  }
  const out = await PDFDocument.create();
  try {
    for (let n = 1; n <= pages; n++) {
      U.checkAbort(ctx);
      const r = await call('renderPage', docId, n, { scale, format: 'jpeg', quality });
      const bytes = Buffer.from((r && r.bytes) || []);
      if (!bytes.length) throw new Error(`Page ${n} rendered empty. Try a lower DPI.`);
      const w = Number(r.width) / scale, h = Number(r.height) / scale;
      if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`Page ${n} has an invalid size.`);
      let jpg;
      try { jpg = await out.embedJpg(bytes); } catch { throw new Error(`Page ${n} could not be embedded. Try a lower quality.`); }
      const page = out.addPage([w, h]);
      page.drawImage(jpg, { x: 0, y: 0, width: w, height: h });
      ctx.progress(n / pages * 0.85, `Rebuilding page ${n} of ${pages}`);
    }
  } catch (e) {
    try { await call('closeDoc', docId); } catch { /* ignore */ }
    throw e;
  }
  try { await call('closeDoc', docId); } catch { /* ignore */ }
  return Buffer.from(await out.save());
}

async function compressPdf(ctx, { file, targetBytes, level = 'medium', password }) {
  inputPdf(file);
  const original = readPdf(file);
  const want = Math.max(0, Math.min(2 * 1024 * 1024 * 1024, Number(targetBytes) || 0));
  const lvl = ['light', 'medium', 'strong', 'lossless'].includes(String(level)) ? String(level) : 'medium';
  ctx.progress(0.05, 'Optimizing');
  let best = null;
  try { best = await mupdfTransform(original, 'compress', cleanPassword(password)); } catch { best = null; }
  const dest = U.outPath(ctx, file, 'pdf', { suffix: ' (compressed)' });
  const settings = { light: [[1.6, 72]], medium: [[1.3, 60]], strong: [[1.0, 45]] };
  const fits = (b) => (want ? b.length <= want : false);
  if (best && best.length < original.length && (fits(best) || lvl === 'lossless')) {
    writePdf(dest, best, 'compressed PDF');
    ctx.progress(1, 'Done');
    return { outputs: [dest], note: want && best.length > want ? 'Could not reach the exact size without making pages unreadable.' : undefined };
  }

  const ladder = want
    ? [[2.0, 80], [1.6, 70], [1.3, 60], [1.1, 50], [0.9, 42], [0.7, 36], [0.55, 30], [0.4, 25]]
    : settings[lvl] || settings.medium;
  let last = null;
  let lastError = null;
  for (let i = 0; i < ladder.length; i++) {
    U.checkAbort(ctx);
    ctx.progress(0.1 + (i / ladder.length) * 0.85, 'Compressing pages');
    try {
      const out = await rasterRebuild(ctx, file, ladder[i][0], ladder[i][1], password);
      last = out;
      if (!want || out.length <= want) break;
    } catch (e) {
      if (e && e.cancelled) throw e;
      lastError = e;
      // One bad pass should not throw away a usable lossless copy we already have.
      if (best && !want) break;
    }
  }
  const candidates = [best, last].filter(Boolean).filter((b) => b.length < original.length);
  const pick = candidates.length ? candidates.sort((a, b) => a.length - b.length)[0] : original;
  if (pick === original && !best && !last && lastError) throw lastError;
  writePdf(dest, pick, 'compressed PDF');
  ctx.progress(1, 'Done');
  return { outputs: [dest], note: pick === original ? 'This PDF is already as small as it can get.' : (want && pick.length > want ? 'Could not reach the exact size without making pages unreadable.' : undefined) };
}

module.exports = { imagesToPdfFile, imagesToPdf, pdfToImages, pdfInfo, thumbnails, mergePdfs, arrangePdf, splitPdf, watermarkPdf, compressPdf, lockPdf, unlockPdf, parseRanges };
