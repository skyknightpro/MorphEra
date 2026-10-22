'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../util');
const { withTimeout } = require('../proc');

let current = null;
let creating = null;

function langDir() {
  // Bundled language packs (used for diagnostics and packaging checks).
  const cands = [];
  try { cands.push(path.dirname(require.resolve('@tesseract.js-data/eng/package.json'))); } catch { /* ignore */ }
  return cands;
}

/**
 * Copy a traineddata file into the shared cache. Comparing sizes repairs a
 * cache left half-written by an interrupted first launch, and writing to a
 * temporary name prevents a partial file from looking valid next time.
 */
function cacheLangFile(src, dest) {
  try {
    const size = fs.statSync(src).size;
    try { if (fs.statSync(dest).size === size) return; } catch { /* missing */ }
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch { /* unreadable pack */ }
}

function normalizeLang(lang) {
  const parts = String(lang || 'eng').split('+').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z]{3}$/.test(s));
  return parts.length ? [...new Set(parts)].join('+') : 'eng';
}

function findLangPath(lang) {
  const dirs = [];
  for (const l of normalizeLang(lang).split('+')) {
    try {
      const pkg = path.dirname(require.resolve(`@tesseract.js-data/${l}/package.json`));
      for (const sub of ['4.0.0_best_int', '4.0.0', '4.0.0_fast', '']) {
        const d = path.join(pkg, sub);
        if (fs.existsSync(path.join(d, `${l}.traineddata.gz`)) || fs.existsSync(path.join(d, `${l}.traineddata`))) { dirs.push(d); break; }
      }
    } catch { /* language pack not installed */ }
  }
  return dirs;
}

async function dispose() {
  const c = current;
  current = null;
  if (!c) return;
  try { await c.worker.terminate(); } catch { /* ignore */ }
}

async function createWorker(lang) {
  let makeWorker;
  try { ({ createWorker: makeWorker } = require('tesseract.js')); }
  catch { throw new Error('The OCR engine is not installed. Reinstall MorphEra to restore text recognition.'); }
  const dirs = findLangPath(lang);
  if (!dirs.length) {
    throw new Error('OCR language data is missing. Reinstall MorphEra to restore text recognition.');
  }

  const opts = {};
  if (dirs.length) {
    // tesseract.js takes one langPath; copy to a merged cache when languages
    // live in different packages.
    const merged = path.join(U.getState().dataDir, 'ocr-lang');
    U.ensureDir(merged);
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      for (const f of files) {
        if (!/traineddata/.test(f)) continue;
        cacheLangFile(path.join(d, f), path.join(merged, f));
      }
    }
    opts.langPath = merged;
    try { opts.gzip = fs.readdirSync(merged).some((f) => f.endsWith('.gz')); } catch { opts.gzip = false; }
    opts.cachePath = merged;
  }

  let worker;
  try {
    worker = await makeWorker(lang, 1, opts);
  } catch (e) {
    throw new Error(/lang|traineddata|network|fetch/i.test(String(e && e.message))
      ? 'The OCR language data could not be loaded. Reinstall MorphEra to restore it.'
      : 'The OCR engine could not start. Please try again.');
  }
  return worker;
}

async function getWorker(lang) {
  const clean = normalizeLang(lang);
  if (current && current.lang === clean) return current.worker;
  if (creating) { try { await creating; } catch { /* the leader reports the error */ } }
  if (current && current.lang === clean) return current.worker;

  creating = (async () => {
    await dispose();
    const worker = await withTimeout(
      createWorker(clean),
      2 * 60 * 1000,
      'Loading the OCR language data took too long. Check that no other copy of MorphEra is using it, then try again.',
      () => { dispose(); },
    );
    current = { lang: clean, worker };
    return worker;
  })();

  try { return await creating; } finally { creating = null; }
}

async function runRecognition(worker, fn) {
  return withTimeout(fn(worker), 5 * 60 * 1000,
    'Text recognition took too long and was stopped. Try a shorter document or fewer pages.',
    () => { dispose(); });
}

function workerCrashed(e) {
  return /terminated|worker|aborted|took too long|out of memory|memory/i.test(String((e && e.message) || e || ''));
}

async function recognizeLines(png, lang = 'eng+ara', onProgress) {
  let worker = await getWorker(lang);
  let data;
  try {
    ({ data } = await runRecognition(worker, (w) => w.recognize(png, {}, { blocks: true })));
  } catch (e) {
    if (!workerCrashed(e)) throw e;
    // A tesseract worker can die after a few large pages. Restart it once.
    await dispose();
    worker = await getWorker(lang);
    ({ data } = await runRecognition(worker, (w) => w.recognize(png, {}, { blocks: true })));
  }
  if (onProgress) onProgress(1);
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    if (!l.text || !l.text.trim()) continue;
    lines.push({ text: l.text, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, conf: l.confidence });
  }
  return lines;
}

async function recognizeText(png, lang = 'eng+ara') {
  let worker = await getWorker(lang);
  try {
    const { data } = await runRecognition(worker, (w) => w.recognize(png));
    return data.text;
  } catch (e) {
    if (!workerCrashed(e)) throw e;
    await dispose();
    worker = await getWorker(lang);
    const { data } = await runRecognition(worker, (w) => w.recognize(png));
    return data.text;
  }
}

async function shutdown() { await dispose(); }

module.exports = { recognizeLines, recognizeText, shutdown, langDir, normalizeLang };
