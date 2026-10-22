'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const U = require('../util');
const { norm } = require('../formats');
const { killTree } = require('../proc');
const officeRuntime = require('../libreoffice-runtime');
const model = require('./pdfmodel');

const OFFICE_TIMEOUT = 10 * 60 * 1000;

const tw = (pt) => Math.round(pt * 20);
const emu = (pt) => Math.round(pt * 12700);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function W(ctx) {
  if (!ctx.services || !ctx.services.worker) throw new Error('The page engine is not available.');
  return (fn, ...args) => ctx.services.worker.call(fn, args);
}

/* ------------------------------------------------------------ open PDF page data */

async function openPdf(ctx, file, password) {
  const call = W(ctx);
  const docId = 'd' + Math.random().toString(36).slice(2);
  try {
    const info = await call('openDoc', docId, fs.readFileSync(file), password);
    return { call, docId, pages: info.pages };
  } catch (e) {
    if (String(e.message).includes('PASSWORD') || /password/i.test(e.message)) {
      throw new Error('This PDF is password protected. Unlock it first with PDF Tools, or enter the password.');
    }
    throw e;
  }
}

async function pageModels(ctx, file, opts, onPage) {
  const { call, docId, pages } = await openPdf(ctx, file, opts.password);
  const models = [];
  try {
    for (let n = 1; n <= pages; n++) {
      U.checkAbort(ctx);
      let content = await call('pageContent', docId, n);
      const chars = content.items.reduce((a, it) => a + (it.str || '').trim().length, 0);
      let scanned = false;
      if ((opts.forceOcr || chars < 12) && opts.ocr !== false && ctx.services.ocr) {
        scanned = true;
        const scale = 3.5;
        const r = await call('renderPage', docId, n, { scale, format: 'png' });
        const lines = await ctx.services.ocr.recognizeLines(Buffer.from(r.bytes), opts.ocrLangs || 'eng+ara', (p) => {
          ctx.progress((n - 1 + p) / pages * 0.85 + 0.05, `OCR page ${n} of ${pages}`);
        });
        content = { width: content.width, height: content.height, items: model.ocrLinesToItems(lines, scale), images: [] };
      }
      const m = model.buildPageModel(content, opts);
      m.scanned = scanned;
      m.number = n;
      models.push(m);
      if (onPage) await onPage(m, { call, docId, n, pages });
      ctx.progress(0.05 + (n / pages) * 0.8, `Reading page ${n} of ${pages}`);
    }
  } finally {
    try { await call('closeDoc', docId); } catch { /* ignore */ }
  }
  return models;
}

async function cropImages(ctx, m, call, docId, n) {
  const imgs = m.blocks.filter((b) => b.kind === 'image');
  if (!imgs.length) return;
  const scale = 2.2;
  const r = await call('renderPage', docId, n, { scale, format: 'png' });
  const full = Buffer.from(r.bytes);
  const meta = await sharp(full).metadata();
  if (!meta.width || !meta.height) return;
  for (const im of imgs) {
    const left = Math.max(0, Math.min(meta.width - 1, Math.round(im.x * scale)));
    const top = Math.max(0, Math.min(meta.height - 1, Math.round(im.y * scale)));
    const width = Math.max(0, Math.min(meta.width - left, Math.round(im.w * scale)));
    const height = Math.max(0, Math.min(meta.height - top, Math.round(im.h * scale)));
    if (width < 4 || height < 4) { im.skip = true; continue; }
    im.data = await sharp(full).extract({ left, top, width, height }).png({ compressionLevel: 6 }).toBuffer();
    im.px = { w: width, h: height };
  }
  if (m.exact) m.fullPage = full;
}

/* ----------------------------------------------------------------- PDF -> DOCX */

function docxLib() { return require('docx'); }

function makeRuns(D, runs, sizeScale = 1) {
  return runs.filter((r) => r.text.length).map((r) => new D.TextRun({
    text: r.text,
    bold: r.bold,
    italics: r.italic,
    size: Math.max(2, Math.round(r.size * 2 * sizeScale)),
    font: { ascii: r.family, hAnsi: r.family, cs: r.family, eastAsia: r.family },
    rightToLeft: !!r.rtl,
    boldComplexScript: r.bold,
    italicsComplexScript: r.italic,
    sizeComplexScript: Math.max(2, Math.round(r.size * 2 * sizeScale)),
  }));
}

const ALIGN = (D) => ({ start: D.AlignmentType.START, end: D.AlignmentType.END, center: D.AlignmentType.CENTER, justify: D.AlignmentType.BOTH });

function pitchOf(b) { return b.lineGap && b.lineGap > b.size * 0.9 ? b.lineGap : b.size * 1.2; }

function flowChildren(D, m) {
  const children = [];
  let cursor = null; // bottom edge of previous block (pt)
  const al = ALIGN(D);
  const text = m.blocks.filter((b) => b.kind !== 'image' || (b.data && !b.skip));
  let prevImg = null;
  for (let bi = 0; bi < text.length; bi++) {
    const b = text[bi];
    if (b.kind === 'para') {
      const pitch = pitchOf(b);
      const topEdge = b.top + b.size - pitch * 0.85 - b.size * 0 + 0;
      const before = cursor == null ? 0 : Math.max(0, topEdge - cursor);
      const custom = b.lineGap && Math.abs(b.lineGap - b.size * 1.17) > b.size * 0.2;
      children.push(new D.Paragraph({
        bidirectional: b.dir === 'rtl',
        alignment: al[b.align] || D.AlignmentType.START,
        indent: b.indent ? { start: tw(b.indent) } : undefined,
        spacing: { before: tw(Math.min(before, 200)), after: 0, ...(custom ? { line: tw(pitch), lineRule: D.LineRuleType.AT_LEAST } : {}) },
        children: makeRuns(D, b.runs),
      }));
      cursor = b.bottom + pitch * 0.25;
      prevImg = null;
    } else if (b.kind === 'table') {
      const gapBefore = cursor == null ? 0 : b.y - cursor;
      if (gapBefore > 3) children.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: tw(Math.min(gapBefore, 200)), lineRule: D.LineRuleType.EXACT }, children: [] }));
      const rows = b.rows.map((r) => (b.rtl ? r.slice().reverse() : r));
      const widths = b.rtl ? b.colWidths.slice().reverse() : b.colWidths;
      const total = widths.reduce((a, x) => a + x, 0);
      const border = { style: D.BorderStyle.SINGLE, size: 4, color: 'A0A0A0' };
      const borders = { top: border, bottom: border, left: border, right: border };
      children.push(new D.Table({
        width: { size: tw(total), type: D.WidthType.DXA },
        columnWidths: widths.map(tw),
        visuallyRightToLeft: !!b.rtl,
        rows: rows.map((r) => new D.TableRow({
          children: r.map((c, ci) => new D.TableCell({
            width: { size: tw(widths[ci]), type: D.WidthType.DXA },
            borders,
            margins: { top: 40, bottom: 40, left: 90, right: 90 },
            children: [new D.Paragraph({
              bidirectional: c.dir === 'rtl',
              alignment: al[c.align] || D.AlignmentType.START,
              spacing: { before: 0, after: 0 },
              children: makeRuns(D, c.runs),
            })],
          })),
        })),
      }));
      children.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT }, children: [] }));
      cursor = b.y + b.rows.length * 20;
    } else if (b.kind === 'image') {
      const wpx = Math.max(8, Math.round(b.w * 96 / 72));
      const hpx = Math.max(8, Math.round(b.h * 96 / 72));
      const center = b.x + b.w / 2;
      const alignment = Math.abs(center - m.width / 2) < m.width * 0.06 ? D.AlignmentType.CENTER : center > m.width * 0.66 ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT;
      const run = new D.ImageRun({ type: 'png', data: b.data, transformation: { width: wpx, height: hpx } });
      if (prevImg && Math.abs(prevImg.y - b.y) < 12) {
        prevImg.p.addChildElement ? null : null;
        children.push(new D.Paragraph({ alignment, spacing: { before: 0, after: 0 }, children: [run] }));
      } else {
        const before = cursor == null ? 0 : Math.max(0, b.y - cursor);
        children.push(new D.Paragraph({ alignment, spacing: { before: tw(Math.min(before, 200)), after: 0 }, children: [run] }));
      }
      prevImg = { y: b.y };
      cursor = b.y + b.h;
    }
  }
  if (!children.length) children.push(new D.Paragraph({ children: [] }));
  return children;
}

function exactChildren(D, m) {
  const out = [];
  const al = ALIGN(D);
  // images (floating, behind text)
  const anchorChildren = [];
  for (const b of m.blocks) {
    if (b.kind !== 'image' || !b.data) continue;
    anchorChildren.push(new D.ImageRun({
      type: 'png', data: b.data,
      transformation: { width: Math.round(b.w * 96 / 72), height: Math.round(b.h * 96 / 72) },
      floating: {
        horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: emu(b.x) },
        verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: emu(b.y) },
        behindDocument: true,
        wrap: { type: D.TextWrappingType.NONE },
      },
    }));
  }
  out.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT }, children: anchorChildren }));
  for (const c of m.cells) {
    if (!c.runs.length) continue;
    const width = c.x1 - c.x0 + c.size * 1.5 + 4;
    const rtl = c.dir === 'rtl';
    const x = rtl ? c.x1 + 2 - width : c.x0 - 1;
    const y = c.base - c.size * 1.0;
    out.push(new D.Paragraph({
      bidirectional: rtl,
      alignment: al.start,
      frame: {
        type: 'absolute',
        position: { x: tw(Math.max(0, x)), y: tw(Math.max(0, y)) },
        width: tw(width),
        height: tw(c.size * 1.45),
        anchor: { horizontal: D.FrameAnchorType.PAGE, vertical: D.FrameAnchorType.PAGE },
        rule: D.HeightRule ? D.HeightRule.ATLEAST : undefined,
      },
      spacing: { before: 0, after: 0, line: tw(c.size * 1.3), lineRule: D.LineRuleType.EXACT },
      children: makeRuns(D, c.runs),
    }));
  }
  return out;
}

async function pdfToDocx(ctx, params) {
  const D = docxLib();
  const { file } = params;
  const opts = params.opts || {};
  const exact = !!opts.exactLayout;
  ctx.progress(0.02, 'Opening PDF');
  const sections = [];
  await pageModels(ctx, file, opts, async (m, ref) => {
    if (opts.noImages !== true && !m.scanned) { m.exact = exact; await cropImages(ctx, m, ref.call, ref.docId, ref.n); }
    if (exact) {
      const sec = {
        properties: { page: { size: { width: tw(m.width), height: tw(m.height) }, margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 } } },
        children: exactChildren(D, m),
      };
      sections.push(sec);
    } else {
      const mg = m.margins;
      sections.push({
        properties: {
          page: {
            size: { width: tw(m.width), height: tw(m.height) },
            margin: {
              top: tw(Math.max(18, Math.min(mg.t - 8, m.height * 0.4))),
              left: tw(Math.max(14, mg.l)), right: tw(Math.max(14, mg.r)),
              bottom: tw(Math.max(24, Math.min(mg.b, 90))), header: 0, footer: 0,
            },
          },
        },
        children: flowChildren(D, m),
      });
    }
  });
  if (!sections.length) throw new Error('This PDF has no pages.');
  ctx.progress(0.9, 'Writing Word file');
  const doc = new D.Document({
    creator: 'MorphEra',
    title: U.baseName(file),
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections,
  });
  const buf = await D.Packer.toBuffer(doc);
  const dest = U.outPath(ctx, file, 'docx');
  fs.writeFileSync(dest, buf);
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

/* ------------------------------------------------------------ PDF -> TXT / HTML */

function blocksToText(m) {
  const parts = [];
  for (const b of m.blocks) {
    if (b.kind === 'para') parts.push(b.runs.map((r) => r.text).join('').replace(/[ \t]+/g, ' ').trim());
    else if (b.kind === 'table') parts.push(b.rows.map((r) => (b.rtl ? r.slice().reverse() : r).map((c) => c.runs.map((x) => x.text).join('').trim()).join('\t')).join('\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

async function pdfToTxt(ctx, params) {
  const { file } = params;
  const opts = params.opts || {};
  const models = await pageModels(ctx, file, opts);
  const text = models.map((m) => blocksToText(m)).join('\n\n\f\n\n');
  const dest = U.outPath(ctx, file, 'txt');
  fs.writeFileSync(dest, '﻿' + text.replace(/\n/g, '\r\n'), 'utf8');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

function runsHtml(runs) {
  return runs.map((r) => {
    let s = esc(r.text);
    const st = `font-family:'${esc(r.family)}',Arial,sans-serif;font-size:${r.size}pt`;
    s = `<span style="${st}">${s}</span>`;
    if (r.bold) s = `<b>${s}</b>`;
    if (r.italic) s = `<i>${s}</i>`;
    return s;
  }).join('');
}

async function modelsToHtml(models, title) {
  const body = [];
  for (const m of models) {
    body.push(`<section class="page">`);
    for (const b of m.blocks) {
      if (b.kind === 'para') {
        const al = b.align === 'center' ? 'center' : b.align === 'justify' ? 'justify' : b.align === 'end' ? (b.dir === 'rtl' ? 'left' : 'right') : (b.dir === 'rtl' ? 'right' : 'left');
        body.push(`<p dir="${b.dir}" style="text-align:${al};${b.indent ? `margin-${b.dir === 'rtl' ? 'right' : 'left'}:${Math.round(b.indent)}pt;` : ''}">${runsHtml(b.runs)}</p>`);
      } else if (b.kind === 'table') {
        body.push(`<table dir="${b.rtl ? 'rtl' : 'ltr'}">${b.rows.map((r) => `<tr>${(b.rtl ? r.slice().reverse() : r).map((c) => `<td dir="${c.dir}">${runsHtml(c.runs)}</td>`).join('')}</tr>`).join('')}</table>`);
      } else if (b.kind === 'image' && b.data) {
        body.push(`<p style="text-align:center"><img src="data:image/png;base64,${b.data.toString('base64')}" style="max-width:100%" /></p>`);
      }
    }
    body.push('</section>');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:'Segoe UI',Arial,Tahoma,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;line-height:1.55;color:#111}
section.page{padding:24px 0;border-bottom:1px dashed #ccc} table{border-collapse:collapse;width:100%;margin:10px 0} td{border:1px solid #bbb;padding:5px 8px}
</style></head><body>${body.join('\n')}</body></html>`;
}

async function pdfToHtml(ctx, params) {
  const { file } = params;
  const opts = params.opts || {};
  const models = await pageModels(ctx, file, opts, async (m, ref) => { if (!m.scanned) await cropImages(ctx, m, ref.call, ref.docId, ref.n); });
  const html = await modelsToHtml(models, U.baseName(file));
  const dest = U.outPath(ctx, file, 'html');
  fs.writeFileSync(dest, html, 'utf8');
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

/* ---------------------------------------------------------- LibreOffice route */

function officePreflight() {
  // Bypass the short discovery cache: the user may have removed or moved
  // LibreOffice after the setup screen was dismissed.
  const bin = U.findLibreOffice({ force: true });
  if (!bin) {
    const err = new Error('LibreOffice is no longer available on this computer. Reinstall it from the setup screen, then try again.');
    err.code = 'LO_MISSING';
    throw err;
  }
  return bin;
}

function officeError(stderr) {
  const text = String(stderr || '').replace(/\s+/g, ' ').trim();
  if (/source file could not be loaded|no such file|does not exist/i.test(text)) {
    return 'LibreOffice could not open this file. It may be damaged or use a format LibreOffice does not support.';
  }
  if (/encrypted|password/i.test(text)) {
    return 'This document is password protected. Remove its password first, then try again.';
  }
  return 'LibreOffice could not convert this file. Close any open LibreOffice windows and try again.';
}

/** LibreOffice sometimes writes a sanitised file name; find whatever it made. */
function findProduced(outDir, baseName, targetExt) {
  const ext = String(targetExt || '').split(':')[0].toLowerCase();
  const expected = path.join(outDir, `${baseName}.${ext}`);
  try { if (fs.statSync(expected).isFile() && fs.statSync(expected).size > 0) return expected; } catch { /* look below */ }
  let best = '';
  let bestSize = -1;
  try {
    for (const entry of fs.readdirSync(outDir)) {
      if (entry.startsWith('~$') || entry.startsWith('.')) continue;
      if (path.extname(entry).toLowerCase() !== '.' + ext) continue;
      if (!entry.toLowerCase().startsWith(baseName.toLowerCase().slice(0, 12))) continue;
      const p = path.join(outDir, entry);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size > bestSize) { best = p; bestSize = st.size; }
      } catch { /* skip */ }
    }
  } catch { /* outDir unreadable */ }
  return best;
}

function runOffice(ctx, file, targetExt, outDir, extraArgs = []) {
  const soffice = officePreflight();
  U.checkAbort(ctx);
  return (async () => {
    // Remove Morphera-owned orphans that may still hold a profile or a file
    // lock before starting a new job. A user's own LibreOffice windows are not
    // touched because they do not use MorphEra's private profile.
    await officeRuntime.killStale();
    U.checkAbort(ctx);

    const profile = officeRuntime.createProfile();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let stderr = '';
      let timer = null;
      let child = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (ctx.signal) { try { ctx.signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
        if (child && child.exitCode == null && !child.killed) killTree(child);
        officeRuntime.cleanupProfile(profile);
        if (err) reject(err); else resolve(value);
      };
      const onAbort = () => finish(new U.Cancelled());

      try {
        child = officeRuntime.spawnOffice(soffice, profile, [
          ...(Array.isArray(extraArgs) ? extraArgs : []),
          '--convert-to', targetExt, '--outdir', outDir, file,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        officeRuntime.cleanupProfile(profile);
        reject(new Error('LibreOffice could not be started. ' + ((e && e.message) || '')));
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        finish(new Error('LibreOffice took too long to convert this file. Try a smaller or simpler document.'));
      }, OFFICE_TIMEOUT);
      if (timer && typeof timer.unref === 'function') timer.unref();

      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8000); if (process.env.MORPH_DEBUG) process.stderr.write(d); });
      child.stdout.on('data', () => { /* drain */ });
      child.on('error', (e) => {
        finish(new Error(e && e.code === 'ENOENT' ? 'LibreOffice could not be found. Install it or locate it in Settings.' : 'LibreOffice could not be started.'));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (ctx.signal && ctx.signal.aborted) { finish(new U.Cancelled()); return; }
        if (timedOut) return;
        if (code !== 0) { finish(new Error(officeError(stderr))); return; }
        const produced = findProduced(outDir, U.baseName(file), targetExt);
        if (!produced) { finish(new Error('LibreOffice did not produce an output file. ' + (stderr.trim() ? officeError(stderr) : ''))); return; }
        finish(null, produced);
      });
    });
  })();
}

/** Which conversions cannot be done without LibreOffice. */
function needsOffice(from, to) {
  const key = `${norm(from)}>${norm(to)}`;
  if (key === 'docx>pdf' || key === 'xls>pdf' || key === 'ods>pdf' || key === 'html>docx') return true;
  if (/^(pptx|ppt|odp)>(png|jpg)$/.test(key)) return true;
  return /^(doc|odt|rtf|pptx|ppt|odp)>(pdf|docx|txt)$/.test(key);
}

async function viaOffice(ctx, file, to, extraArgs = []) {
  const tmp = U.tmpDir('office');
  try {
    ctx.progress(0.1, 'Converting with LibreOffice');
    const produced = await runOffice(ctx, file, to, tmp, extraArgs);
    if (!U.fileSize(produced)) throw new Error('LibreOffice produced an empty file. Close the document and try again.');
    const dest = U.outPath(ctx, file, to);
    fs.copyFileSync(produced, dest);
    if (!U.fileSize(dest)) throw new Error('The converted document could not be saved.');
    ctx.progress(0.95, 'Finishing');
    return { outputs: [dest] };
  } finally { U.rmQuiet(tmp); }
}

/* ------------------------------------------------------------- HTML helpers */

function printCss() {
  return `<style>
  @page { margin: 18mm; }
  body{font-family:'Segoe UI','Segoe UI Variable',Tahoma,Arial,sans-serif;font-size:11.5pt;line-height:1.55;color:#111}
  p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre{unicode-bidi:plaintext;text-align:start}
  table{border-collapse:collapse;margin:8px 0} td,th{border:1px solid #999;padding:4px 7px}
  img{max-width:100%} pre{white-space:pre-wrap;font-family:inherit}
  </style>`;
}

function autoDir(html) {
  return html.replace(/<(p|li|h[1-6]|td|th|blockquote)(\s|>)/gi, (_m, t, e) => `<${t} dir="auto"${e === '>' ? '>' : ' '}`);
}

async function htmlToPdfFile(ctx, html, dest, o = {}) {
  if (!ctx.services || !ctx.services.printHtmlToPdf) throw new Error('The PDF printing engine is not available.');
  const buf = await ctx.services.printHtmlToPdf(html, o);
  fs.writeFileSync(dest, buf);
}

function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------- DOCX / TXT */

async function docxToHtml(file) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: file });
  return r.value;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.slice(2)); b.swap16(); return b.toString('utf16le'); }
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

async function textToDocx(file, dest) {
  const D = docxLib();
  const text = readText(file);
  const paras = text.split(/\r?\n/).map((line) => {
    const rtl = model.RTL_RE.test(line);
    return new D.Paragraph({
      bidirectional: rtl,
      spacing: { after: 100 },
      children: line ? [new D.TextRun({ text: line, rightToLeft: rtl, font: { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial' }, size: 24 })] : [],
    });
  });
  const doc = new D.Document({ creator: 'MorphEra', sections: [{ children: paras }] });
  fs.writeFileSync(dest, await D.Packer.toBuffer(doc));
}

/* ----------------------------------------------------------------- sheets */

function readWorkbook(file) {
  const XLSX = require('xlsx');
  const ext = norm(U.extOf(file));
  const buf = fs.readFileSync(file);
  return { XLSX, wb: XLSX.read(buf, { type: 'buffer', cellDates: true, ...(ext === 'csv' ? { codepage: 65001 } : {}) }) };
}

async function sheetConvert(ctx, file, to) {
  const { XLSX, wb } = readWorkbook(file);
  if (to === 'xlsx') {
    const dest = U.outPath(ctx, file, 'xlsx');
    XLSX.writeFile(wb, dest, { bookType: 'xlsx' });
    return { outputs: [dest] };
  }
  if (to === 'csv') {
    const names = wb.SheetNames;
    if (names.length === 1) {
      const dest = U.outPath(ctx, file, 'csv');
      fs.writeFileSync(dest, '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[names[0]]), 'utf8');
      return { outputs: [dest] };
    }
    const dir = U.outFolder(ctx, `${U.baseName(file)} (sheets)`);
    const outs = names.map((n) => {
      const p = U.uniquePath(dir, `${U.baseName(file)} - ${n}`, 'csv');
      fs.writeFileSync(p, '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[n]), 'utf8');
      return p;
    });
    return { outputs: outs, folder: dir };
  }
  const tables = wb.SheetNames.map((n) => `<h3>${esc(n)}</h3>` + XLSX.utils.sheet_to_html(wb.Sheets[n]).replace(/^[\s\S]*?<body>/i, '').replace(/<\/body>[\s\S]*$/i, ''));
  const wide = wb.SheetNames.some((n) => { const r = wb.Sheets[n]['!ref']; if (!r) return false; const d = XLSX.utils.decode_range(r); return d.e.c - d.s.c > 7; });
  const html = `<!doctype html><html><head><meta charset="utf-8">${printCss()}</head><body>${autoDir(tables.join('<br/>'))}</body></html>`;
  if (to === 'html') {
    const dest = U.outPath(ctx, file, 'html');
    fs.writeFileSync(dest, html, 'utf8');
    return { outputs: [dest] };
  }
  const dest = U.outPath(ctx, file, 'pdf');
  await htmlToPdfFile(ctx, html, dest, { landscape: wide });
  return { outputs: [dest] };
}

/* -------------------------------------------------------------- dispatcher */

async function convertDocument(ctx, params) {
  const { file } = params;
  const ext = norm(U.extOf(file));
  const to = norm(params.to);
  const opts = params.opts || {};
  const key = `${ext}>${to}`;
  ctx.progress(0.02, 'Starting');
  // Fail before doing any work when a conversion fundamentally needs
  // LibreOffice. The startup gate normally prevents this path entirely.
  if (needsOffice(ext, to)) officePreflight();

  switch (key) {
    case 'pdf>docx': return pdfToDocx(ctx, params);
    case 'pdf>txt': return pdfToTxt(ctx, params);
    case 'pdf>html': return pdfToHtml(ctx, params);
    case 'pdf>png':
    case 'pdf>jpg': return require('./pdf').pdfToImages(ctx, { file, format: to, dpi: opts.dpi || 200, quality: opts.quality || 90, password: opts.password });

    case 'docx>txt': {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: file });
      const dest = U.outPath(ctx, file, 'txt');
      fs.writeFileSync(dest, '﻿' + r.value.replace(/\n/g, '\r\n'), 'utf8');
      return { outputs: [dest] };
    }
    case 'docx>html': {
      const html = `<!doctype html><html><head><meta charset="utf-8">${printCss()}</head><body>${autoDir(await docxToHtml(file))}</body></html>`;
      const dest = U.outPath(ctx, file, 'html');
      fs.writeFileSync(dest, html, 'utf8');
      return { outputs: [dest] };
    }
    case 'docx>pdf': return viaOffice(ctx, file, 'pdf');
    case 'txt>pdf': {
      const html = `<!doctype html><html><head><meta charset="utf-8">${printCss()}</head><body><pre dir="auto">${esc(readText(file))}</pre></body></html>`;
      const dest = U.outPath(ctx, file, 'pdf');
      await htmlToPdfFile(ctx, html.replace('<pre dir="auto">', '<pre>'), dest);
      return { outputs: [dest] };
    }
    case 'txt>docx': { const dest = U.outPath(ctx, file, 'docx'); await textToDocx(file, dest); return { outputs: [dest] }; }
    case 'txt>html': {
      const lines = readText(file).split(/\r?\n/).map((l) => `<p dir="auto">${esc(l) || '&nbsp;'}</p>`).join('\n');
      const dest = U.outPath(ctx, file, 'html');
      fs.writeFileSync(dest, `<!doctype html><html><head><meta charset="utf-8">${printCss()}</head><body>${lines}</body></html>`, 'utf8');
      return { outputs: [dest] };
    }
    case 'html>pdf': {
      const raw = readText(file);
      const html = /<head[\s>]/i.test(raw) ? raw.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">`) : `<!doctype html><html><head><meta charset="utf-8">${printCss()}</head><body>${raw}</body></html>`;
      const dest = U.outPath(ctx, file, 'pdf');
      await htmlToPdfFile(ctx, html, dest);
      return { outputs: [dest] };
    }
    case 'html>txt': { const dest = U.outPath(ctx, file, 'txt'); fs.writeFileSync(dest, '﻿' + stripHtml(readText(file)).replace(/\n/g, '\r\n'), 'utf8'); return { outputs: [dest] }; }
    // HTML normally opens in LibreOffice's Writer/Web module, which has no
    // DOCX export filter. Force the regular Writer HTML importer so the result
    // can be exported as a Word document.
    case 'html>docx': return viaOffice(ctx, file, 'docx', ['--infilter=HTML (StarWriter)']);

    case 'xlsx>csv': case 'xlsx>pdf': case 'xlsx>html': case 'xls>csv': case 'xls>xlsx': case 'xls>html': case 'ods>csv': case 'ods>xlsx': case 'ods>html':
    case 'csv>xlsx': case 'csv>pdf': case 'csv>html':
      return sheetConvert(ctx, file, to);
    case 'xls>pdf': case 'ods>pdf': return viaOffice(ctx, file, 'pdf');

    case 'pptx>png': case 'pptx>jpg': case 'ppt>png': case 'ppt>jpg': case 'odp>png': case 'odp>jpg': {
      const tmp = U.tmpDir('office');
      try {
        const pdf = await runOffice(ctx, file, 'pdf', tmp);
        return await require('./pdf').pdfToImages(ctx, { file: pdf, format: to, dpi: 150, quality: 90, baseName: U.baseName(file) });
      } finally { U.rmQuiet(tmp); }
    }
    default:
      if (/^(doc|odt|rtf|pptx|ppt|odp)>(pdf|docx|txt)$/.test(key)) return viaOffice(ctx, file, to);
      throw new Error(`Converting ${ext.toUpperCase()} to ${to.toUpperCase()} is not supported.`);
  }
}

module.exports = { convertDocument, pdfToDocx, pdfToTxt, pdfToHtml, runOffice, officePreflight, needsOffice, htmlToPdfFile, pageModels, autoDir, printCss };
