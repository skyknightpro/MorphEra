'use strict';
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const U = require('../util');
const { norm } = require('../formats');
const background = require('./background');

// Keep sharp's caches bounded but enabled: disabling them entirely made large
// batches slower. A modest shared libvips thread pool keeps peak memory stable
// while still using the machine well.
sharp.cache({ memory: 64, files: 20, items: 100 });
try { sharp.concurrency(Math.max(1, Math.min(4, ((os.cpus() || []).length || 2) - 1))); } catch { /* older sharp */ }

const LOSSY = new Set(['jpg', 'webp', 'avif']);

/* ------------------------------------------------------------------ input */

async function ffmpegDecodeToPng(ctx, file) {
  const media = require('./media');
  const out = U.tmpFile('png', 'dec');
  try {
    await media.runFfmpeg(ctx, ['-y', '-i', file, '-frames:v', '1', out], { noProgress: true, timeoutMs: 120000 });
    return fs.readFileSync(out);
  } catch (e) {
    if (e instanceof U.Cancelled) throw e;
    throw new Error('This image could not be decoded. It may be damaged or in an unsupported variant.');
  } finally {
    U.rmQuiet(out);
  }
}

async function loadInput(ctx, file) {
  let st;
  try { st = fs.statSync(file); } catch { throw new Error('The file could not be found. It may have been moved or deleted.'); }
  if (!st.isFile()) throw new Error('That path is not a file.');
  if (!st.size) throw new Error('The file is empty.');

  const ext = norm(U.extOf(file));
  if (ext === 'heic') {
    let convert;
    try { convert = require('heic-convert'); } catch { throw new Error('HEIC support is not installed. Reinstall MorphEra to restore it.'); }
    try {
      const out = await convert({ buffer: fs.readFileSync(file), format: 'PNG' });
      return { buf: Buffer.from(out), animated: false };
    } catch {
      throw new Error('This HEIC photo could not be read. It may be damaged or use an unsupported variant.');
    }
  }
  if (ext === 'bmp' || ext === 'ico') return { buf: await ffmpegDecodeToPng(ctx, file), animated: false };
  if (ext === 'svg') return { buf: fs.readFileSync(file), animated: false, svg: true };
  return { buf: fs.readFileSync(file), animated: ext === 'gif' || ext === 'webp' };
}

function mk(buf, opts = {}) {
  const o = { failOn: 'none', limitInputPixels: false, ...opts };
  return sharp(buf, o);
}

function keepMeta(img, strip) {
  if (strip) return img;
  if (typeof img.keepMetadata === 'function') return img.keepMetadata();
  return img.withMetadata();
}

async function toPng(img) {
  return img.png({ compressionLevel: 1 }).toBuffer();
}

/* -------------------------------------------------------------- BMP / ICO */

async function encodeBMP(buf) {
  const { data, info } = await mk(buf).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const stride = (w * 3 + 3) & ~3;
  const size = 54 + stride * h;
  const out = Buffer.alloc(size);
  out.write('BM', 0);
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * h, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 3;
    let o = 54 + y * stride;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 3;
      out[o++] = data[s + 2];
      out[o++] = data[s + 1];
      out[o++] = data[s];
    }
  }
  return out;
}

async function encodeICO(buf) {
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = [];
  for (const sz of sizes) {
    pngs.push(await mk(buf).resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
  }
  return require('../ico').encodeICO(pngs, sizes);
}

/* ---------------------------------------------------------------- encoder */

async function encodeBuffer(buf, fmt, o = {}) {
  const q = Math.max(1, Math.min(100, Math.round(o.quality || 85)));
  const strip = o.stripMeta !== false;
  fmt = norm(fmt);
  if (fmt === 'bmp') return encodeBMP(buf);
  if (fmt === 'ico') return encodeICO(buf);
  let img = mk(buf, o.animated ? { animated: true } : {});
  img = keepMeta(img, strip);
  if (o.density) img = img.withMetadata({ density: o.density });
  switch (fmt) {
    case 'jpg':
      return img.flatten({ background: o.background || '#ffffff' }).jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' }).toBuffer();
    case 'png':
      return img.png(o.palette ? { palette: true, quality: q, effort: 7, compressionLevel: 9 } : { compressionLevel: 9, effort: 7 }).toBuffer();
    case 'webp':
      return img.webp({ quality: q, effort: 4 }).toBuffer();
    case 'avif':
      return img.avif({ quality: q, effort: 4 }).toBuffer();
    case 'tiff':
      return img.tiff({ quality: q, compression: 'lzw' }).toBuffer();
    case 'gif':
      return img.gif({ effort: 7 }).toBuffer();
    default:
      throw new Error(`Unsupported image format: ${fmt}`);
  }
}

// Find the best encoding that stays under `target` bytes.
async function encodeToTarget(buf, fmt, target, startQuality, ctx) {
  fmt = norm(fmt);
  const { data, info } = await mk(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawOpts = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const scaled = async (s) => {
    if (s >= 1) return sharp(data, rawOpts).png({ compressionLevel: 0 }).toBuffer();
    return sharp(data, rawOpts).resize(Math.max(8, Math.round(info.width * s)), Math.max(8, Math.round(info.height * s)), { kernel: 'lanczos3' }).png({ compressionLevel: 0 }).toBuffer();
  };
  const enc = (b, q, extra = {}) => encodeBuffer(b, fmt, { quality: q, stripMeta: true, ...extra });
  const hiQ = Math.min(95, startQuality || 90);

  const full = await scaled(1);
  let base = full;

  if (LOSSY.has(fmt)) {
    U.checkAbort(ctx);
    const top = await enc(base, hiQ);
    if (top.length <= target) return top;
    let lo = 40, hi = hiQ, best = null;
    for (let i = 0; i < 7 && lo < hi; i++) {
      U.checkAbort(ctx);
      const mid = Math.round((lo + hi) / 2);
      const out = await enc(base, mid);
      if (out.length <= target) { best = out; lo = mid + 1; } else hi = mid - 1;
    }
    if (best) return best;
    const low = await enc(base, 40);
    if (low.length <= target) return low;
  } else if (fmt === 'png') {
    const lossless = await enc(base, 100);
    if (lossless.length <= target) return lossless;
    for (const q of [90, 70, 50]) {
      U.checkAbort(ctx);
      const out = await enc(base, q, { palette: true });
      if (out.length <= target) return out;
    }
  } else {
    const out = await enc(base, 90);
    if (out.length <= target) return out;
  }

  // Shrink dimensions until it fits.
  let last = null;
  for (const s of [0.85, 0.7, 0.55, 0.45, 0.35, 0.28, 0.2, 0.15, 0.1, 0.06]) {
    U.checkAbort(ctx);
    base = await scaled(s);
    const extra = fmt === 'png' ? { palette: true } : {};
    const out = await enc(base, LOSSY.has(fmt) ? 70 : 60, extra);
    last = out;
    if (out.length <= target) {
      if (LOSSY.has(fmt)) {
        let lo = 50, hi = 92, best = out;
        for (let i = 0; i < 5 && lo < hi; i++) {
          const mid = Math.round((lo + hi) / 2);
          const o2 = await enc(base, mid);
          if (o2.length <= target) { best = o2; lo = mid + 1; } else hi = mid - 1;
        }
        return best;
      }
      return out;
    }
  }
  return last;
}

/* --------------------------------------------------------------- features */

/**
 * Background removal runs in the isolated worker process (see
 * electron/engines/background.js). Keeping the ONNX runtime out of the main
 * process prevents native crashes and unbounded memory growth from taking the
 * whole app down.
 */
async function removeBackground(ctx, pngBuf) {
  if (!background.available()) {
    throw new Error('Background removal is not available in this build. Reinstall MorphEra to restore it.');
  }

  // Normalise the input first: the model expects a well-formed PNG, and doing
  // this here gives a clearer error for corrupt images than a native failure.
  let input;
  try {
    input = await mk(pngBuf).ensureAlpha().png({ compressionLevel: 1 }).toBuffer();
  } catch {
    throw new Error('This image could not be prepared for background removal. It may be damaged or empty.');
  }

  const out = await background.removeBackground(ctx, input);

  let meta;
  try { meta = await mk(out).metadata(); } catch { meta = null; }
  if (!meta || !meta.width || !meta.height) {
    throw new Error('The background removal engine returned an invalid image. Please try again.');
  }
  // Some ONNX builds return RGB even though the alpha channel carries the
  // mask. Add an opaque alpha channel in that case so PNG/WEBP exports behave
  // consistently instead of showing a black or white background.
  if (!meta.hasAlpha) {
    try { return await mk(out).ensureAlpha().png({ compressionLevel: 1 }).toBuffer(); }
    catch { throw new Error('The background removal result could not be prepared. Please try again.'); }
  }
  return out;
}

async function textPng(ctx, o) {
  if (ctx.services && ctx.services.renderText) return ctx.services.renderText(o);
  const fs_ = Math.round(o.fontSize);
  const w = Math.ceil(o.text.length * fs_ * 0.62) + 20;
  const h = Math.ceil(fs_ * 1.5);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="10" y="${fs_}" font-size="${fs_}" font-family="Arial, sans-serif" font-weight="bold" fill="${o.color || '#ffffff'}">${o.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function applyWatermark(ctx, buf, wm) {
  const meta = await mk(buf).metadata();
  const W = meta.width, H = meta.height;
  const sizePct = Math.max(2, Math.min(100, wm.size || 30)) / 100;
  let overlay;
  if (wm.type === 'image') {
    if (!wm.imagePath) throw new Error('Choose a watermark image first.');
    const src = (await loadInput(ctx, wm.imagePath)).buf;
    overlay = await mk(src).resize({ width: Math.max(8, Math.round(W * sizePct)) }).png().toBuffer();
  } else {
    if (!wm.text) throw new Error('Type the watermark text first.');
    const fontSize = Math.max(10, Math.round(W * sizePct * 0.28));
    overlay = await textPng(ctx, { text: wm.text, fontSize, color: wm.color || '#ffffff', shadow: true });
  }
  if (wm.rotate) {
    overlay = await mk(overlay).rotate(wm.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  }
  const opacity = Math.max(0.05, Math.min(1, (wm.opacity == null ? 60 : wm.opacity) / 100));
  // apply opacity to the overlay alpha channel
  const ov = await mk(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < ov.data.length; i += 4) ov.data[i] = Math.round(ov.data[i] * opacity);
  overlay = await sharp(ov.data, { raw: { width: ov.info.width, height: ov.info.height, channels: 4 } }).png().toBuffer();
  let om = await mk(overlay).metadata();
  if (om.width > W || om.height > H) {
    overlay = await mk(overlay).resize({ width: W, height: H, fit: 'inside' }).png().toBuffer();
    om = await mk(overlay).metadata();
  }
  const margin = Math.round(Math.min(W, H) * 0.03);
  const pos = wm.position || 'br';
  if (pos === 'tile') {
    return mk(buf).composite([{ input: overlay, tile: true, gravity: 'center' }]).png({ compressionLevel: 1 }).toBuffer();
  }
  const left = pos.includes('l') ? margin : pos.includes('r') ? W - om.width - margin : Math.round((W - om.width) / 2);
  const top = pos.includes('t') ? margin : pos.includes('b') ? H - om.height - margin : Math.round((H - om.height) / 2);
  return mk(buf).composite([{ input: overlay, left: Math.max(0, left), top: Math.max(0, top) }]).png({ compressionLevel: 1 }).toBuffer();
}

/* --------------------------------------------------------------- pipeline */

function hasEdits(e) {
  if (!e) return false;
  return !!((e.rotate && e.rotate % 360) || e.flipH || e.flipV || e.crop || e.removeBg || (e.resize && e.resize.mode && e.resize.mode !== 'none')
    || (e.enhance && (e.enhance.upscale > 1 || e.enhance.sharpen > 0 || e.enhance.denoise)) || e.watermark);
}

async function applyEdits(ctx, input, edits, stripMeta) {
  let buf = input.buf;
  const sharpOpts = input.svg ? { density: 192 } : {};
  // 1. orientation / rotate / flip
  let img = mk(buf, sharpOpts).rotate(); // auto-orient
  buf = await toPngKeep(img, stripMeta);
  const rot = ((edits.rotate || 0) % 360 + 360) % 360;
  if (rot) buf = await toPngKeep(mk(buf).rotate(rot), stripMeta);
  if (edits.flipV) buf = await toPngKeep(mk(buf).flip(), stripMeta);
  if (edits.flipH) buf = await toPngKeep(mk(buf).flop(), stripMeta);
  U.checkAbort(ctx);

  // 2. crop
  if (edits.crop && edits.crop.w > 1 && edits.crop.h > 1) {
    const m = await mk(buf).metadata();
    const c = edits.crop;
    const left = Math.max(0, Math.min(m.width - 1, Math.round(c.x)));
    const top = Math.max(0, Math.min(m.height - 1, Math.round(c.y)));
    const width = Math.max(1, Math.min(m.width - left, Math.round(c.w)));
    const height = Math.max(1, Math.min(m.height - top, Math.round(c.h)));
    buf = await toPngKeep(mk(buf).extract({ left, top, width, height }), stripMeta);
  }

  // 3. background removal
  if (edits.removeBg) {
    ctx.progress(0.3, 'Removing background');
    buf = await removeBackground(ctx, await mk(buf).png({ compressionLevel: 1 }).toBuffer());
    ctx.progress(0.42, 'Refining edges');
    // A tiny alpha promise check catches engines that silently return an
    // image without transparency, which used to look like a failed removal.
    const meta = await mk(buf).metadata();
    if (!meta.hasAlpha) throw new Error('The background could not be removed from this image. Try a photo with a clearer subject.');
  }
  U.checkAbort(ctx);

  // 4. resize
  const r = edits.resize;
  if (r && r.mode && r.mode !== 'none') {
    const m = await mk(buf).metadata();
    let rz = null;
    if (r.mode === 'percent') {
      const p = Math.max(1, r.percent || 100) / 100;
      rz = { width: Math.max(1, Math.round(m.width * p)), height: Math.max(1, Math.round(m.height * p)) };
    } else if (r.mode === 'maxEdge') {
      const e = r.maxEdge || 1600;
      if (Math.max(m.width, m.height) > e) rz = m.width >= m.height ? { width: e } : { height: e };
    } else if (r.mode === 'exact') {
      rz = { width: r.width || undefined, height: r.height || undefined, fit: r.fit || 'inside', withoutEnlargement: false };
      if (!rz.width && !rz.height) rz = null;
    }
    if (rz) buf = await toPngKeep(mk(buf).resize({ kernel: 'lanczos3', ...rz }), stripMeta);
  }

  // 5. enhance / upscale
  const en = edits.enhance;
  if (en && (en.upscale > 1 || en.sharpen > 0 || en.denoise)) {
    ctx.progress(0.5, 'Enhancing');
    let im = mk(buf);
    if (en.upscale > 1) {
      const m = await mk(buf).metadata();
      im = im.resize({ width: Math.round(m.width * en.upscale), height: Math.round(m.height * en.upscale), kernel: 'lanczos3' });
      buf = await toPngKeep(im, stripMeta);
      im = mk(buf);
    }
    if (en.denoise) { buf = await toPngKeep(im.median(3), stripMeta); im = mk(buf); }
    const s = en.sharpen != null ? en.sharpen : (en.upscale > 1 ? 0.6 : 0);
    if (s > 0) buf = await toPngKeep(im.sharpen({ sigma: 0.6 + s * 1.2, m1: 0.8, m2: 1.4 + s * 2 }), stripMeta);
  }
  U.checkAbort(ctx);

  // 6. watermark
  if (edits.watermark) {
    ctx.progress(0.6, 'Adding watermark');
    buf = await applyWatermark(ctx, buf, edits.watermark);
  }
  return buf;
}

async function toPngKeep(img, strip) {
  return keepMeta(img, strip).png({ compressionLevel: 1 }).toBuffer();
}

/**
 * Convert / edit / compress a single image.
 * params: { file, to, edits, opts:{quality,targetBytes,maxBytes,stripMeta,density,background} }
 */
async function processImage(ctx, params) {
  const { file } = params;
  const to = norm(params.to || U.extOf(file));
  const edits = params.edits || {};
  const o = params.opts || {};
  const strip = o.stripMeta === true;
  if (edits.removeBg && !background.available()) {
    throw new Error('Background removal is not available in this build. Reinstall MorphEra to restore it.');
  }
  ctx.progress(0.05, 'Reading image');
  const input = await loadInput(ctx, file);
  U.checkAbort(ctx);

  const sourceExt = norm(U.extOf(file));
  const inPlaceSame = sourceExt === to || (sourceExt === 'jpg' && to === 'jpg');
  const wantsAnimated = input.animated && (to === 'gif' || to === 'webp') && !hasEdits(edits) && !o.targetBytes && !o.maxBytes;

  let buf;
  if (hasEdits(edits)) {
    buf = await applyEdits(ctx, input, edits, strip);
  } else if (wantsAnimated) {
    buf = input.buf;
  } else {
    buf = await toPngKeep(mk(input.buf, input.svg ? { density: 192 } : {}).rotate(), strip);
  }
  ctx.progress(0.7, 'Encoding');

  const quality = o.quality || 85;
  let out;
  const target = o.targetBytes || 0;
  const limit = o.maxBytes || 0;

  if (to === 'pdf') {
    const meta = await mk(buf).metadata();
    const useJpeg = !meta.hasAlpha;
    const tmp = U.tmpFile(useJpeg ? 'jpg' : 'png', 'img2pdf');
    try {
      const encoded = useJpeg ? await encodeBuffer(buf, 'jpg', { quality: Math.max(60, quality), stripMeta: true }) : await mk(buf).png().toBuffer();
      if (!encoded || !encoded.length) throw new Error('The image could not be encoded for the PDF.');
      fs.writeFileSync(tmp, encoded);
      const pdf = require('./pdf');
      const dest = U.outPath(ctx, file, 'pdf');
      await pdf.imagesToPdfFile(ctx, [tmp], dest, { fit: 'image' });
      if (!U.fileSize(dest)) throw new Error('The PDF could not be written.');
      return { outputs: [dest] };
    } finally { U.rmQuiet(tmp); }
  }

  if (target > 0) {
    out = await encodeToTarget(buf, to, target, quality, ctx);
  } else {
    out = await encodeBuffer(buf, to, { quality, stripMeta: strip, density: o.density, background: o.background, animated: wantsAnimated, palette: false });
    if (limit > 0 && out.length > limit) out = await encodeToTarget(buf, to, limit, quality, ctx);
  }

  if (!out || !out.length) throw new Error('The image could not be encoded. Try another output format.');
  const suffix = inPlaceSame && !hasEdits(edits) ? ' (compressed)' : (hasEdits(edits) ? ' (edited)' : '');
  const dest = U.outPath(ctx, file, to === 'jpg' ? 'jpg' : to, { suffix: inPlaceSame ? suffix : (hasEdits(edits) ? ' (edited)' : '') });
  try {
    fs.writeFileSync(dest, out);
  } catch (e) {
    U.rmQuiet(dest);
    if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM')) throw e;
    throw new Error('The converted image could not be saved.');
  }
  if (!U.fileSize(dest)) { U.rmQuiet(dest); throw new Error('The converted image was saved empty. Try again.'); }

  const wanted = target || limit;
  const note = wanted && out.length > wanted * 1.05 ? 'Could not reach the exact size without making the image unreadable.' : undefined;
  ctx.progress(1, 'Done');
  return { outputs: [dest], note };
}

async function imageInfo(ctx, file) {
  const input = await loadInput(ctx || {}, file);
  const m = await mk(input.buf, input.svg ? { density: 192 } : {}).metadata();
  const dims = (m.orientation || 1) >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
  if (!dims.width || !dims.height) throw new Error('This image could not be read.');
  return { ...dims, hasAlpha: !!m.hasAlpha, format: m.format || norm(U.extOf(file)) };
}

/**
 * Build a browser preview without decoding the original twice. The previous
 * implementation encoded a lossless PNG just to read its dimensions, which
 * doubled peak memory on large photos.
 */
async function previewImage(ctx, file, maxEdge = 1800) {
  const limit = Math.max(240, Math.min(4096, Number(maxEdge) || 1800));
  const input = await loadInput(ctx || {}, file);
  const opts = input.svg ? { density: 192 } : {};

  const meta = await mk(input.buf, opts).metadata();
  if (!meta.width || !meta.height) throw new Error('This image could not be read.');
  const swap = (meta.orientation || 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;
  if (!W || !H) throw new Error('This image could not be read.');

  const scale = Math.min(1, limit / Math.max(W, H));
  let img = mk(input.buf, opts).rotate();
  if (scale < 1) {
    img = img.resize({ width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)), fit: 'inside', withoutEnlargement: true });
  }
  const alpha = !!meta.hasAlpha;
  const buf = alpha
    ? await img.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
    : await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (!buf || !buf.length) throw new Error('The preview could not be created.');
  return { dataUrl: `data:${alpha ? 'image/png' : 'image/jpeg'};base64,${buf.toString('base64')}`, width: W, height: H, scale };
}

module.exports = { processImage, imageInfo, previewImage, encodeBuffer, encodeToTarget, loadInput, applyWatermark, hasEdits };
