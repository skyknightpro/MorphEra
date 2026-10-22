'use strict';
// Turns raw positioned text from a PDF page into a structured page model
// (paragraphs, tables, images) that can be written as DOCX, HTML or TXT.
// Handles right-to-left scripts (Arabic / Hebrew), including PDFs that store
// text glyph-by-glyph in visual order using presentation forms.

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LAT_RE = /[A-Za-z0-9À-ɏͰ-ԯ぀-ヿ一-鿿가-힯]/;
const PRES_RE = /[ﬀ-ﬆﭐ-﷿ﹰ-﻿]/;

const typeOf = (s) => (RTL_RE.test(s) ? 'R' : LAT_RE.test(s) ? 'L' : 'N');
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))]; };

function prettyFont(name) {
  if (!name) return 'Arial';
  let n = String(name).replace(/^[A-Z]{6}\+/, '').replace(/(PSMT|MT|PS)$/i, '').replace(/[-_,].*$/, '');
  if (/^(times|timesnewroman|timesnewromanps)$/i.test(n)) return 'Times New Roman';
  if (/^(arialmt|arial)$/i.test(n)) return 'Arial';
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (!n || /^(f\d+|g\d+|font|type\d*|cid.*|identity.*|opensymbol)$/i.test(n.replace(/\s/g, ''))) return 'Arial';
  if (/^dejavu\s?sans$/i.test(n)) return 'DejaVu Sans';
  return n;
}

function normText(s) {
  return PRES_RE.test(s) ? s.normalize('NFKC') : s;
}

/* ------------------------------------------------------------ line building */

function buildLines(items) {
  const toks = [];
  for (let it of items) {
    if (!it.str || !it.str.length) continue;
    if (Math.abs(it.rot || 0) > 0.3) continue; // skip rotated text (side labels)
    const marks = /^\s+[\u064B-\u065F\u0670\u06D6-\u06ED]+$/.test(it.str);
    if (marks) it = { ...it, str: it.str.trim(), w: 0 };
    const space = !it.str.trim();
    toks.push({ ...it, space, type: space ? 'N' : typeOf(it.str) });
  }
  toks.sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const t of toks) {
    let line = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
      const l = lines[i];
      if (Math.abs(l.base - t.base) <= 0.45 * Math.min(l.size, t.size || l.size)) { line = l; break; }
    }
    if (!line) { line = { base: t.base, size: t.size, tokens: [] }; lines.push(line); }
    line.tokens.push(t);
    if (!t.space && t.str.trim().length > 0) line.size = Math.max(line.size * 0.0 + t.size, 0) || line.size;
  }
  for (const l of lines) {
    l.tokens.sort((a, b) => a.x - b.x);
    // representative size = most common non-space token size
    const sizes = l.tokens.filter((t) => !t.space).map((t) => Math.round(t.size * 2) / 2);
    l.size = median(sizes) || l.size;
    const real = l.tokens.filter((t) => !t.space);
    l.x0 = real.length ? Math.min(...real.map((t) => t.x)) : 0;
    l.x1 = real.length ? Math.max(...real.map((t) => t.x + t.w)) : 0;
  }
  return lines.filter((l) => l.tokens.some((t) => !t.space)).sort((a, b) => a.base - b.base);
}

function splitCells(line) {
  const real = line.tokens;
  const cells = [];
  let cur = [];
  let lastEnd = null;
  const thr = Math.max(14, 1.3 * line.size);
  for (const t of real) {
    if (t.space) { cur.push(t); continue; }
    if (lastEnd != null && t.x - lastEnd > thr && cur.some((c) => !c.space)) {
      cells.push(cur);
      cur = [];
    }
    cur.push(t);
    lastEnd = Math.max(lastEnd == null ? -1e9 : lastEnd, t.x + t.w);
  }
  if (cur.some((c) => !c.space)) cells.push(cur);
  return cells.map((tokens) => {
    const nz = tokens.filter((t) => !t.space);
    return { tokens, x0: Math.min(...nz.map((t) => t.x)), x1: Math.max(...nz.map((t) => t.x + t.w)) };
  });
}

/* --------------------------------------------- tokens -> logical styled runs */

function tokensToRuns(tokens, size) {
  const vis = tokens.filter((t) => t.str.length);
  // trim leading / trailing spaces
  while (vis.length && vis[0].space) vis.shift();
  while (vis.length && vis[vis.length - 1].space) vis.pop();
  if (!vis.length) return { runs: [], dir: 'ltr', text: '' };

  const nR = vis.filter((t) => t.type === 'R').reduce((a, t) => a + t.str.length, 0);
  const nL = vis.filter((t) => t.type === 'L').reduce((a, t) => a + t.str.length, 0);
  const paraRtl = nR > nL;

  // resolve neutral tokens
  const dirs = vis.map((t) => (t.type === 'R' ? 'R' : t.type === 'L' ? 'L' : null));
  for (let i = 0; i < vis.length; i++) {
    if (dirs[i]) continue;
    let p = i - 1; while (p >= 0 && !dirs[p]) p--;
    let n = i + 1; while (n < vis.length && !dirs[n]) n++;
    const pd = p >= 0 ? dirs[p] : null;
    const nd = n < vis.length ? dirs[n] : null;
    dirs[i] = pd && nd && pd === nd ? pd : (paraRtl ? 'R' : 'L');
  }
  // neutrals were resolved from original dirs only; refresh to avoid chain effects
  const resolved = dirs.slice();

  // visual runs
  const runs = [];
  for (let i = 0; i < vis.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.dir === resolved[i]) last.tokens.push(vis[i]);
    else runs.push({ dir: resolved[i], tokens: [vis[i]] });
  }
  const ordered = paraRtl ? runs.slice().reverse() : runs;
  const logical = [];
  for (const r of ordered) {
    const toks = r.dir === 'R' ? r.tokens.slice().reverse() : r.tokens;
    toks.forEach((t) => logical.push({ t, rtl: r.dir === 'R' }));
  }

  // style runs
  const out = [];
  let prev = null;
  const push = (text, t, rtl) => {
    if (!text) return;
    const style = { family: prettyFont(t.family), bold: !!t.bold, italic: !!t.italic, size: Math.round(t.size * 2) / 2, rtl };
    const last = out[out.length - 1];
    if (last && last.family === style.family && last.bold === style.bold && last.italic === style.italic && last.size === style.size && last.rtl === style.rtl) last.text += text;
    else out.push({ ...style, text });
  };
  for (const { t, rtl } of logical) {
    if (t.space) {
      if (prev && !prev.space) push(' ', prev.t || t, rtl);
      prev = { space: true, t };
      continue;
    }
    if (prev && !prev.space) {
      const a = prev.tok, b = t;
      const gap = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) - (a.w + b.w) / 2;
      if (gap > 0.18 * Math.max(a.size, b.size) && !/\s$/.test(out.length ? out[out.length - 1].text : '')) push(' ', b, rtl);
    }
    push(t.str, t, rtl);
    prev = { space: false, tok: t, t };
  }
  for (const r of out) r.text = normText(r.text);
  const text = out.map((r) => r.text).join('');
  return { runs: out, dir: paraRtl ? 'rtl' : 'ltr', text };
}

/* ------------------------------------------------------------- page model */

function buildPageModel(page, opts = {}) {
  const W = page.width, H = page.height;
  const lines = buildLines(page.items || []);
  const info = lines.map((l) => ({ line: l, cells: splitCells(l) }));

  // text area
  const wide = lines.filter((l) => l.x1 - l.x0 > W * 0.35);
  const base = wide.length ? wide : lines;
  let L = base.length ? pct(base.map((l) => l.x0), 0.1) : 56;
  let R = base.length ? pct(base.map((l) => l.x1), 0.9) : W - 56;
  if (R - L < W * 0.3) { L = 56; R = W - 56; }
  const blocks = [];
  let top = lines.length ? Math.max(0, lines[0].base - lines[0].size) : 56;
  let bottom = lines.length ? Math.max(...lines.map((l) => l.base)) : H - 56;

  // group lines into runs of table-like rows / plain lines
  let i = 0;
  while (i < info.length) {
    const row = info[i];
    if (row.cells.length >= 2) {
      let j = i;
      while (j + 1 < info.length && info[j + 1].cells.length === row.cells.length
        && info[j + 1].line.base - info[j].line.base < Math.max(4.5 * info[j].line.size, 60)) j++;
      if (j > i) {
        const rows = info.slice(i, j + 1);
        const asColumns = isColumnLayout(rows);
        if (asColumns) pushColumnBlocks(blocks, rows, W);
        else pushTableBlock(blocks, rows, L, R);
        i = j + 1;
        continue;
      }
    }
    // plain line (possibly multi-cell single rows -> join)
    blocks.push({ kind: 'line', y: row.line.base - row.line.size, line: row.line, cells: row.cells });
    i++;
  }

  // merge consecutive plain lines into paragraphs
  const merged = mergeParagraphs(blocks, { L, R, W });

  // images
  for (const im of page.images || []) {
    if (im.w * im.h > W * H * 0.9 && lines.length > 3) continue; // full-page backgrounds
    merged.push({ kind: 'image', y: im.y, key: [im.y, 0, im.y], x: im.x, w: im.w, h: im.h });
  }
  merged.sort((a, b) => cmpKey(a.key || [a.y, 0, a.y], b.key || [b.y, 0, b.y]));
  const cells = [];
  for (const r of info) for (const c of r.cells) {
    const rr = tokensToRuns(c.tokens, r.line.size);
    if (rr.runs.length) cells.push({ runs: rr.runs, dir: rr.dir, x0: c.x0, x1: c.x1, base: r.line.base, size: r.line.size });
  }
  return { cells, width: W, height: H, margins: { l: L, r: W - R, t: top, b: Math.max(24, H - bottom - 10) }, blocks: merged, textBox: { L, R } };
}

function cmpKey(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

function isColumnLayout(rows) {
  if (rows.length < 5) return false;
  const gaps = [];
  for (let k = 1; k < rows.length; k++) gaps.push(rows[k].line.base - rows[k - 1].line.base);
  const size = median(rows.map((r) => r.line.size));
  const tight = median(gaps) <= 1.7 * size;
  const longText = median(rows.map((r) => Math.max(...r.cells.map((c) => c.tokens.reduce((a, t) => a + t.str.length, 0))))) >= 28;
  return tight && longText;
}

function pushTableBlock(blocks, rows, L, R) {
  const n = rows[0].cells.length;
  const dirGuess = rows.map((r) => r.cells.map((c) => tokensToRuns(c.tokens, r.line.size)));
  const rtlCount = dirGuess.flat().filter((c) => c.dir === 'rtl').length;
  const tableRtl = rtlCount > dirGuess.flat().length / 2;
  const colX0 = Array.from({ length: n }, (_, c) => Math.min(...rows.map((r) => r.cells[c].x0)));
  const colX1 = Array.from({ length: n }, (_, c) => Math.max(...rows.map((r) => r.cells[c].x1)));
  const bounds = [];
  for (let c = 0; c < n; c++) {
    const start = c === 0 ? Math.min(colX0[0], L) : (colX1[c - 1] + colX0[c]) / 2;
    const end = c === n - 1 ? Math.max(colX1[n - 1], R) : (colX1[c] + colX0[c + 1]) / 2;
    bounds.push([start, end]);
  }
  const trows = rows.map((r, ri) => r.cells.map((c, ci) => {
    const rr = dirGuess[ri][ci];
    const cx = (c.x0 + c.x1) / 2;
    const [b0, b1] = bounds[ci];
    const center = (b0 + b1) / 2;
    let align = 'start';
    if (Math.abs(cx - center) < 0.06 * (b1 - b0) && c.x0 - b0 > 0.1 * (b1 - b0)) align = 'center';
    else if (b1 - c.x1 < 0.08 * (b1 - b0) && c.x0 - b0 > 0.25 * (b1 - b0)) align = rr.dir === 'rtl' ? 'start' : 'end';
    return { runs: rr.runs, dir: rr.dir, align, size: r.line.size };
  }));
  const y = rows[0].line.base - rows[0].line.size;
  blocks.push({ kind: 'table', y, key: [y, 0, y], rows: trows, colWidths: bounds.map((b) => Math.max(20, b[1] - b[0])), rtl: tableRtl,
    left: bounds[0][0], right: bounds[n - 1][1] });
}

function pushColumnBlocks(blocks, rows, W) {
  const n = rows[0].cells.length;
  const top = rows[0].line.base - rows[0].line.size;
  const rtlCount = rows.flatMap((r) => r.cells.map((c) => tokensToRuns(c.tokens, r.line.size).dir)).filter((d) => d === 'rtl').length;
  const rtl = rtlCount > (rows.length * n) / 2;
  const order = Array.from({ length: n }, (_, k) => (rtl ? n - 1 - k : k));
  order.forEach((c, k) => {
    for (const r of rows) {
      const cell = r.cells[c];
      blocks.push({ kind: 'line', y: r.line.base - r.line.size, key: [top, k + 1, r.line.base], line: { ...r.line, x0: cell.x0, x1: cell.x1 }, cells: [cell] });
    }
  });
}

function mergeParagraphs(blocks, { L, R, W }) {
  const out = [];
  let cur = null;
  const textW = Math.max(100, R - L);
  const flush = () => { if (cur) { out.push(finishParagraph(cur, { L, R, W })); cur = null; } };
  for (const b of blocks) {
    if (b.kind !== 'line') { flush(); out.push(b); continue; }
    const cell = b.cells.length === 1 ? b.cells[0] : null;
    const tokens = cell ? cell.tokens : b.cells.flatMap((c) => c.tokens);
    const rr = tokensToRuns(tokens, b.line.size);
    const entry = { line: b.line, x0: cell ? cell.x0 : b.line.x0, x1: cell ? cell.x1 : b.line.x1, rr, key: b.key };
    if (!rr.runs.length) continue;
    if (cur) {
      const prev = cur.lines[cur.lines.length - 1];
      const gap = b.line.base - prev.line.base;
      const lineH = Math.max(prev.line.size, b.line.size) * 1.25;
      const sameKeyGroup = !b.key || !cur.key || (b.key[0] === cur.key[0] && b.key[1] === cur.key[1]);
      const sizeChanged = Math.abs(prev.line.size - b.line.size) > 1.2;
      const prevShort = cur.rtl ? (prev.x0 - L > 0.18 * textW) : (R - prev.x1 > 0.18 * textW);
      const indentJump = cur.rtl ? Math.abs(prev.x1 - entry.x1) > 3 * b.line.size : Math.abs(prev.x0 - entry.x0) > 3 * b.line.size;
      const styleBreak = (isAllBold(prev.rr) !== isAllBold(rr)) && (prev.rr.text.length < 90);
      const centered = (e) => Math.abs((e.x0 + e.x1) / 2 - (L + R) / 2) < 0.03 * textW && e.x0 - L > 0.08 * textW;
      const centerBreak = centered(prev) !== centered(entry);
      if (!sameKeyGroup || gap > 1.55 * lineH || gap < 0.2 * lineH || sizeChanged || prevShort || indentJump || styleBreak || centerBreak) flush();
    }
    if (!cur) cur = { lines: [], rtl: rr.dir === 'rtl', key: b.key, y: b.y };
    cur.lines.push(entry);
  }
  flush();
  return out;
}

function isAllBold(rr) { return rr.runs.length > 0 && rr.runs.every((r) => r.bold || !r.text.trim()); }

function finishParagraph(cur, { L, R, W }) {
  const lines = cur.lines;
  const first = lines[0];
  const textW = Math.max(100, R - L);
  const rtl = cur.rtl;
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const centerOffset = Math.abs((x0 + x1) / 2 - (L + R) / 2);
  let align = 'start';
  const spansFull = lines.length >= 3 && lines.slice(0, -1).every((l) => Math.abs(l.x1 - R) < 0.025 * textW && Math.abs(l.x0 - L) < 0.03 * textW);
  if (lines.every((l) => Math.abs((l.x0 + l.x1) / 2 - (L + R) / 2) < 0.03 * textW) && (x0 - L) > 0.06 * textW) align = 'center';
  else if (spansFull) align = 'justify';
  else if (!rtl && R - x1 < 0.02 * textW && x0 - L > 0.35 * textW) align = 'end';
  else if (rtl && x0 - L < 0.02 * textW && R - x1 > 0.35 * textW) align = 'end';
  const indentStart = rtl ? Math.max(0, R - x1) : Math.max(0, first.x0 - L);
  const runs = [];
  lines.forEach((l, idx) => {
    l.rr.runs.forEach((r) => {
      const last = runs[runs.length - 1];
      if (idx > 0 && runs.length && !/\s$/.test(runs[runs.length - 1].text) && !/^\s/.test(r.text) && !/-$/.test(runs[runs.length - 1].text)) {
        // line wrap -> single space
        const lr = runs[runs.length - 1];
        lr.text += ' ';
        void last;
      }
      const prev = runs[runs.length - 1];
      if (prev && prev.family === r.family && prev.bold === r.bold && prev.italic === r.italic && prev.size === r.size && prev.rtl === r.rtl) prev.text += r.text;
      else runs.push({ ...r });
    });
  });
  const gaps = [];
  for (let k = 1; k < lines.length; k++) gaps.push(lines[k].line.base - lines[k - 1].line.base);
  const size = median(lines.map((l) => l.line.size));
  const lineGap = gaps.length ? median(gaps) : 0;
  void W; void centerOffset;
  return {
    kind: 'para', y: cur.y, key: cur.key || [cur.y, 0, cur.y], dir: rtl ? 'rtl' : 'ltr', align, runs, size,
    indent: align === 'start' && indentStart > 6 ? Math.min(indentStart, textW * 0.6) : 0,
    lineGap, top: first.line.base - first.line.size, bottom: lines[lines.length - 1].line.base,
    x0, x1,
  };
}

/* ------------------------------------------------ OCR output -> page items */

function ocrLinesToItems(lines, scale) {
  const items = [];
  for (const l of lines) {
    const text = (l.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const h = (l.y1 - l.y0) / scale;
    const size = Math.max(6, h * 0.72);
    const rtl = RTL_RE.test(text);
    items.push({
      str: text, x: l.x0 / scale, base: l.y1 / scale - h * 0.22, w: (l.x1 - l.x0) / scale, size,
      dir: rtl ? 'rtl' : 'ltr', rot: 0, family: 'Arial', bold: false, italic: false, eol: true, logical: true,
    });
  }
  return items;
}

module.exports = { buildPageModel, ocrLinesToItems, tokensToRuns, prettyFont, RTL_RE, normText };
