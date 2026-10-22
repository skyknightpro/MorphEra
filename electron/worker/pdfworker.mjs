// Runs inside a hidden window. Uses a real DOM canvas for rendering, so text shaping and
// fonts (including Arabic) behave like a normal browser.
import * as pdfjsLib from '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'legacy/build/pdf.worker.mjs';

const docs = new Map();
const MAX_CANVAS_DIM = 16384;
// Chrome refuses canvases above a device-dependent area limit. Staying well
// below it keeps very large pages and high DPI requests from rendering blank.
const MAX_CANVAS_PIXELS = 100 * 1000 * 1000;

export async function openDoc(docId, bytes, password) {
  const old = docs.get(docId);
  if (old) {
    docs.delete(docId);
    try { await old.pdf.destroy(); } catch { /* ignore */ }
  }
  if (!bytes || !bytes.length) throw new Error('The PDF is empty.');
  const task = pdfjsLib.getDocument({
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    iccUrl: BASE + 'iccs/',
    wasmUrl: BASE + 'wasm/',
    password: password || undefined,
    isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    docs.set(docId, { pdf, task });
    return { pages: pdf.numPages };
  } catch (e) {
    try { await task.destroy(); } catch { /* ignore */ }
    throw e;
  }
}

export async function closeDoc(docId) {
  const d = docs.get(docId);
  if (!d) return true;
  docs.delete(docId);
  try { await d.pdf.destroy(); } catch { /* ignore */ }
  try { await d.task.destroy(); } catch { /* ignore */ }
  return true;
}

function getDoc(docId) {
  const d = docs.get(docId);
  if (!d) throw new Error('This document is no longer open. Please reopen the PDF.');
  return d.pdf;
}

function maxCanvasScale(page, requested) {
  const base = page.getViewport({ scale: 1 });
  let scale = Math.max(0.05, Number(requested) || 1);
  let w = base.width * scale;
  let h = base.height * scale;
  const factor = Math.min(1, MAX_CANVAS_DIM / Math.max(w, h), Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, w * h)));
  if (factor < 1) {
    scale *= factor;
    w = base.width * scale;
    h = base.height * scale;
  }
  return { scale, width: w, height: h };
}

const BOLD_RE = /bold|black|heavy|semibold|demi|extrabold/i;
const ITALIC_RE = /italic|oblique|slanted/i;

function mul(m1, m2) {
  // PDF matrix multiply: result = m1 x m2 (row vector convention)
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export async function pageContent(docId, pageNum, wantImages = true) {
  const pdf = getDoc(docId);
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
  let ops = null;
  if (wantImages || true) {
    try { ops = await page.getOperatorList(); } catch { ops = null; }
  }

  // resolve real font names (bold/italic/family)
  const fontInfo = {};
  const resolveFont = (fontName) => {
    if (fontInfo[fontName]) return fontInfo[fontName];
    let real = '';
    try {
      const f = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
      if (f) real = f.name || f.loadedName || '';
    } catch { /* ignore */ }
    const style = tc.styles[fontName] || {};
    const clean = String(real).replace(/^[A-Z]{6}\+/, '');
    const family = clean.replace(/[-,](Bold|Italic|Regular|Oblique|BoldItalic|BoldMT|MT|PS|PSMT).*$/i, '') || style.fontFamily || 'Arial';
    const info = { family, bold: BOLD_RE.test(clean), italic: ITALIC_RE.test(clean), generic: style.fontFamily || '' };
    fontInfo[fontName] = info;
    return info;
  };

  const items = [];
  for (const it of tc.items) {
    if (!it.str && !it.hasEOL) continue;
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(t[2], t[3]) || Math.abs(it.height) || 10;
    const fi = resolveFont(it.fontName);
    items.push({
      str: it.str,
      x: t[4],
      base: t[5],
      w: Math.abs(it.width * viewport.scale),
      size,
      dir: it.dir,
      rot: Math.abs(t[1]) > 0.01 * size ? Math.atan2(t[1], t[0]) : 0,
      family: fi.family,
      bold: fi.bold,
      italic: fi.italic,
      eol: !!it.hasEOL,
    });
  }

  const images = [];
  if (ops) {
    const OPS = pdfjsLib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const vt = viewport.transform;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ops.argsArray[i], ctm);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject
        || fn === OPS.paintImageXObjectRepeat) {
        const m = mul(ctm, vt);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
        const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
        if (w > 6 && h > 6) images.push({ x, y, w, h, mask: fn === OPS.paintImageMaskXObject });
      }
    }
  }
  return { width: viewport.width, height: viewport.height, items, images, rotation: page.rotate || 0 };
}

export async function renderPage(docId, pageNum, o = {}) {
  const pdf = getDoc(docId);
  const page = await pdf.getPage(pageNum);
  const m = maxCanvasScale(page, o.scale || 1.5);
  const viewport = page.getViewport({ scale: m.scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('The page renderer could not create a canvas.');
  canvas.width = width;
  canvas.height = height;
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;

    const mime = o.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = Math.max(0.1, Math.min(1, (Number(o.quality) || 90) / 100));
    const blob = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw new Error('The page could not be turned into an image. Try a lower DPI.');
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (!buf.length) throw new Error('The page rendered empty. Try a lower DPI.');
    return { bytes: buf, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    try { page.cleanup(); } catch { /* ignore */ }
  }
}

export async function renderText(o) {
  const size = Math.max(8, Math.min(400, Number(o.fontSize) || 48));
  const pad = Math.ceil(size * 0.35);
  // Watermark text is user input; cap it so a pathological string cannot ask
  // for a canvas larger than Chrome supports.
  const text = String(o.text || '').slice(0, 4000);
  if (!text) throw new Error('Type the watermark text first.');
  const rtl = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(text);
  const font = `${o.bold === false ? '' : 'bold '}${size}px "Segoe UI", "Segoe UI Variable", Tahoma, Arial, sans-serif`;
  const lines = text.split(/\r?\n/).slice(0, 120);
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('The text renderer is not available.');
  probe.font = font;
  const widths = lines.map((l) => probe.measureText(l).width);
  const lineH = Math.ceil(size * 1.3);
  const width = Math.ceil(Math.max(...widths, 10)) + pad * 2;
  const height = lineH * lines.length + pad * 2;
  if (width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM || width * height > MAX_CANVAS_PIXELS) {
    throw new Error('The watermark text is too long to render. Shorten it and try again.');
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The text renderer is not available.');
  canvas.width = width;
  canvas.height = height;
  try {
    ctx.font = font;
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = o.color || '#ffffff';
    if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = Math.max(2, size * 0.08); ctx.shadowOffsetY = 1; }
    lines.forEach((l, i) => ctx.fillText(l, rtl ? width - pad : pad, pad + lineH * i + lineH / 2));
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('The watermark could not be rendered.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function thumbnails(docId, pages, maxEdge = 220) {
  const pdf = getDoc(docId);
  const list = (Array.isArray(pages) ? pages : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1).slice(0, 300);
  const out = [];
  const edge = Math.max(60, Math.min(600, Number(maxEdge) || 220));
  for (const n of list) {
    const page = await pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const scale = edge / Math.max(v1.width, v1.height);
    const r = await renderPage(docId, n, { scale, format: 'jpeg', quality: 70 });
    let bin = '';
    const b = r.bytes;
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    out.push({ page: n, w: v1.width, h: v1.height, rotate: page.rotate || 0, dataUrl: 'data:image/jpeg;base64,' + btoa(bin) });
  }
  return out;
}

const API = { openDoc, closeDoc, pageContent, renderPage, renderText, thumbnails };

if (typeof window !== 'undefined' && window.workerBridge) {
  window.workerBridge.onRequest(async (msg) => {
    try {
      if (!API[msg.fn]) throw new Error('Unknown worker function: ' + msg.fn);
      const result = await API[msg.fn](...(msg.args || []));
      window.workerBridge.respond({ id: msg.id, ok: true, result });
    } catch (e) {
      const m = e && e.name === 'PasswordException' ? 'PASSWORD' : (e && e.message) || String(e);
      window.workerBridge.respond({ id: msg.id, ok: false, error: m });
    }
  });
  window.workerBridge.ready();
}
window.__morphWorker = API;
