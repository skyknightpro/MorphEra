import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Reorder } from 'framer-motion';
import { api, fmtBytes, extLabel, errorText } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Icon, Button, IconButton, Segmented, Slider, PageHeader, Card, TextInput, motion, AnimatePresence, spring } from '../ui.jsx';
import { DropZone, FILTERS, FileThumb } from '../pagekit.jsx';

const TABS = [
  { id: 'organize', label: 'Organize', icon: 'grid' },
  { id: 'merge', label: 'Merge', icon: 'merge' },
  { id: 'split', label: 'Split', icon: 'split' },
  { id: 'toimg', label: 'PDF → Images', icon: 'image' },
  { id: 'fromimg', label: 'Images → PDF', icon: 'file' },
  { id: 'ocr', label: 'Text (OCR)', icon: 'scan' },
  { id: 'lock', label: 'Lock / Unlock', icon: 'lock' },
  { id: 'wm', label: 'Watermark', icon: 'drop' },
];

function usePdf(onLoaded) {
  const { toast } = useApp();
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState(null);
  const [pw, setPw] = useState('');
  const load = useCallback(async (paths, password) => {
    try {
      const d = (await api.describe(paths)).filter((x) => x.ext === 'pdf');
      if (!d.length) { toast('Please choose a PDF', 'error'); return; }
      const f = d[0];
      setPw(password || '');
      setFile(f); setMeta(null);
      try {
        const m = await api.pdfInfo(f.path, password);
        setMeta(m);
        if (onLoaded) onLoaded(f, m, password);
      } catch (e) {
        setFile(null); setMeta(null);
        toast(errorText(e, 'This PDF could not be read'), 'error');
      }
    } catch (e) { toast(errorText(e, 'That file could not be read.'), 'error'); }
  }, [toast, onLoaded]);
  return { file, setFile, meta, setMeta, pw, setPw, load };
}

function FileBar({ file, meta, onChange, extra }) {
  return (
    <Card className="filebar">
      <FileThumb file={{ ...file, category: 'document' }} />
      <div className="grow"><div className="frow-name">{file.name}</div><div className="muted small">{meta && !meta.locked ? `${meta.pages} page${meta.pages > 1 ? 's' : ''} · ` : ''}{fmtBytes(file.size)}{meta && meta.locked ? ' · locked' : ''}</div></div>
      {extra}
      <Button size="sm" variant="ghost" onClick={onChange}>Change</Button>
    </Card>
  );
}

/* ----------------------------------------------------------------- organize */
function Organize({ pdf, pick }) {
  const { run, toast, setDockOpen } = useApp();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const dragFrom = useRef(null);
  useEffect(() => {
    let alive = true;
    if (!pdf.file || !pdf.meta || pdf.meta.locked) { setPages([]); return; }
    setLoading(true);
    api.pdfThumbs(pdf.file.path, null, pdf.pw || undefined, 220).then((r) => { if (alive) setPages(r.thumbs.map((t) => ({ key: t.page, index: t.page - 1, rotate: 0, url: t.dataUrl, w: t.w, h: t.h }))); }).catch((e) => toast(errorText(e, 'Could not read the pages'), 'error')).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [pdf.file, pdf.meta]); // eslint-disable-line
  const save = async () => {
    if (!pages.length) { toast('Keep at least one page', 'error'); return; }
    try {
      await run([{ kind: 'arrange-pdf', file: pdf.file.path, order: pages.map((p) => ({ index: p.index, rotate: p.rotate })), opts: { password: pdf.pw } }], [{ name: pdf.file.name, to: 'pdf', srcSize: pdf.file.size, t: Date.now() }]);
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'That PDF could not be saved.'), 'error'); }
  };
  if (!pdf.file) return <DropZone onPick={pick} title="Drop a PDF to organize its pages" icon="grid" />;
  const changed = pages.length !== (pdf.meta && pdf.meta.pages) || pages.some((p, i) => p.index !== i || p.rotate);
  return (
    <>
      <FileBar file={pdf.file} meta={pdf.meta} onChange={pick} />
      {pdf.meta && pdf.meta.locked ? <LockedNote pdf={pdf} /> : (
        <>
          <p className="hint">Drag pages to reorder. Use the buttons on each page to rotate or remove it.</p>
          <div className="pgrid">
            <AnimatePresence initial={false}>
              {pages.map((p, i) => (
                <motion.div key={p.key} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={spring} className="pcard glass" draggable
                  onDragStart={() => { dragFrom.current = i; }} onDragOver={(e) => { e.preventDefault(); const f = dragFrom.current; if (f == null || f === i) return; setPages((cur) => { const n = cur.slice(); const [m] = n.splice(f, 1); n.splice(i, 0, m); return n; }); dragFrom.current = i; }} onDragEnd={() => { dragFrom.current = null; }}>
                  <div className="pthumb"><img src={p.url} alt="" draggable={false} style={{ transform: `rotate(${p.rotate}deg)`, maxWidth: p.rotate % 180 ? 120 : '100%', maxHeight: p.rotate % 180 ? 120 : '100%' }} /></div>
                  <div className="pfoot"><span>{i + 1}</span>
                    <div><IconButton icon="rotate" title="Rotate" size={14} onClick={() => setPages((c) => c.map((x) => (x.key === p.key ? { ...x, rotate: (x.rotate + 90) % 360 } : x)))} /><IconButton icon="trash" title="Remove page" size={14} onClick={() => setPages((c) => c.filter((x) => x.key !== p.key))} /></div></div>
                </motion.div>
              ))}
            </AnimatePresence>
            {loading && <div className="muted">Loading pages…</div>}
          </div>
          <div className="actionbar glass"><div className="ab-info"><b>{pages.length}</b> pages</div><div className="grow" /><Button variant="primary" icon="download" disabled={!changed} onClick={save}>Save new PDF</Button></div>
        </>
      )}
    </>
  );
}

function LockedNote({ pdf }) {
  const { toast } = useApp();
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (!v) { toast('Type the password first', 'error'); return; }
    setBusy(true);
    try {
      const m = await api.pdfInfo(pdf.file.path, v);
      if (m.locked || !m.pages) throw new Error('Wrong password.');
      pdf.setPw(v); pdf.setMeta(m);
    } catch (e) {
      toast(errorText(e, 'Wrong password, or this PDF cannot be unlocked.'), 'error');
    } finally { setBusy(false); }
  };
  return (
    <Card className="locked-note"><Icon name="lock" size={22} /><div className="grow"><b>This PDF is locked</b><div className="muted small">Enter its password to continue.</div></div>
      <TextInput type="password" value={v} onChange={setV} placeholder="Password" width={200} onEnter={open} />
      <Button disabled={busy} onClick={open}>{busy ? 'Opening…' : 'Open'}</Button></Card>
  );
}

/* -------------------------------------------------------------------- merge */
function MergeTab({ kind }) {
  const { run, toast, setDockOpen } = useApp();
  const [items, setItems] = useState([]);
  const id = useRef(0);
  const isImg = kind === 'fromimg';
  const add = useCallback(async (paths) => {
    try {
      const d = (await api.describe(paths)).filter((x) => (isImg ? x.category === 'image' : x.ext === 'pdf'));
      if (!d.length) { toast(isImg ? 'Choose image files' : 'Choose PDF files', 'error'); return; }
      setItems((cur) => [...cur, ...d.filter((x) => !cur.some((c) => c.path === x.path)).map((x) => ({ ...x, id: ++id.current }))]);
    } catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  }, [isImg, toast]);
  useDrop(add);
  const pick = async () => {
    try { const p = await api.pick({ filters: isImg ? FILTERS.image : FILTERS.pdf }); if (p.length) await add(p); }
    catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  };
  const go = async () => {
    if (!isImg && items.length < 2) { toast('Add at least two PDFs', 'error'); return; }
    if (isImg && !items.length) return;
    try {
      await run([{ kind: isImg ? 'images-to-pdf' : 'merge-pdf', files: items.map((i) => i.path), opts: {} }], [{ name: isImg ? `${items.length} images` : `${items.length} PDFs`, to: 'pdf', srcSize: items.reduce((a, i) => a + i.size, 0), t: Date.now() }]);
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'That PDF could not be created.'), 'error'); }
  };
  if (!items.length) return <DropZone onPick={pick} title={isImg ? 'Drop images to build a PDF' : 'Drop two or more PDFs'} icon={isImg ? 'image' : 'merge'} />;
  return (
    <>
      <p className="hint">Drag to set the order.</p>
      <Reorder.Group axis="y" values={items} onReorder={setItems} className="flist reorder">
        {items.map((f, i) => (
          <Reorder.Item key={f.id} value={f} className="frow glass grab" whileDrag={{ scale: 1.02, boxShadow: '0 14px 40px rgba(0,0,0,.35)' }}>
            <span className="order">{i + 1}</span><FileThumb file={f} />
            <div className="frow-main"><div className="frow-name">{f.name}</div><div className="frow-meta"><span className="tag">{extLabel(f.ext)}</span><span className="muted">{fmtBytes(f.size)}</span></div></div>
            <IconButton icon="trash" title="Remove" onClick={() => setItems((c) => c.filter((x) => x.id !== f.id))} size={16} />
          </Reorder.Item>
        ))}
      </Reorder.Group>
      <div className="actionbar glass"><Button icon="plus" onClick={pick}>Add more</Button><div className="grow" /><Button variant="primary" icon={isImg ? 'file' : 'merge'} onClick={go}>{isImg ? 'Create PDF' : `Merge ${items.length} PDFs`}</Button></div>
    </>
  );
}

/* --------------------------------------------------------------- single-file */
function SingleTab({ tab, pdf, pick }) {
  const { run, toast, setDockOpen } = useApp();
  const [splitMode, setSplitMode] = useState('each');
  const [every, setEvery] = useState('2');
  const [ranges, setRanges] = useState('1-3, 4-');
  const [fmt, setFmt] = useState('png');
  const [dpi, setDpi] = useState(200);
  const [lang, setLang] = useState('eng+ara');
  const [out, setOut] = useState('docx');
  const [newPw, setNewPw] = useState('');
  const [lockMode, setLockMode] = useState('lock');
  const [wm, setWm] = useState({ type: 'text', text: 'CONFIDENTIAL', imagePath: '', position: 'center', opacity: 35, size: 50, color: '#888888' });
  const f = pdf.file;
  const meta = (extra = {}) => [{ name: f.name, to: extra.to || 'pdf', srcSize: f.size, t: Date.now() }];
  const go = async (spec, m) => {
    try {
      await run([{ ...spec, file: f.path }], m || meta());
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'That PDF job could not be started.'), 'error'); }
  };

  if (!f) return <DropZone onPick={pick} title="Drop a PDF here" icon="file" />;
  const locked = pdf.meta && pdf.meta.locked;
  const common = { password: pdf.pw };
  return (
    <>
      <FileBar file={f} meta={pdf.meta} onChange={pick} />
      {locked && tab !== 'lock' && <LockedNote pdf={pdf} />}
      {(!locked || tab === 'lock') && (
        <Card className="tool-card">
          {tab === 'split' && (<>
            <div className="opt-title">Split this PDF</div>
            <Segmented value={splitMode} onChange={setSplitMode} options={[{ value: 'each', label: 'Every page' }, { value: 'every', label: 'Every N pages' }, { value: 'ranges', label: 'Custom ranges' }]} />
            {splitMode === 'every' && <div className="row"><span className="muted">Pages per file</span><TextInput value={every} onChange={(v) => setEvery(v.replace(/\D/g, ''))} width={90} /></div>}
            {splitMode === 'ranges' && <><TextInput value={ranges} onChange={setRanges} placeholder="1-3, 5, 8-" /><div className="hint">Each comma-separated part becomes its own PDF. Example: 1-3, 5, 8- (to the end).</div></>}
            <Button variant="primary" icon="split" onClick={() => go({ kind: 'split-pdf', split: { mode: splitMode, every: Number(every) || 1, ranges }, opts: common })}>Split</Button>
          </>)}
          {tab === 'toimg' && (<>
            <div className="opt-title">Turn every page into an image</div>
            <Segmented value={fmt} onChange={setFmt} options={[{ value: 'png', label: 'PNG (sharp)' }, { value: 'jpg', label: 'JPG (smaller)' }]} />
            <Slider label="Detail" value={dpi} min={72} max={400} step={4} onChange={setDpi} format={(v) => v + ' DPI'} />
            <Button variant="primary" icon="image" onClick={() => go({ kind: 'pdf-to-images', to: fmt, opts: { dpi, quality: 90, ...common } }, meta({ to: fmt }))}>Create images</Button>
          </>)}
          {tab === 'ocr' && (<>
            <div className="opt-title">Read text from scanned pages</div>
            <div className="lbl">Language</div>
            <Segmented value={lang} onChange={setLang} options={[{ value: 'eng+ara', label: 'English + Arabic' }, { value: 'eng', label: 'English' }, { value: 'ara', label: 'Arabic' }]} />
            <div className="lbl">Save as</div>
            <Segmented value={out} onChange={setOut} options={[{ value: 'docx', label: 'Word' }, { value: 'txt', label: 'Text' }, { value: 'html', label: 'Web page' }]} />
            <Button variant="primary" icon="scan" onClick={() => go({ kind: 'convert', to: out, opts: { forceOcr: true, ocrLangs: lang, ...common } }, meta({ to: out }))}>Recognize text</Button>
          </>)}
          {tab === 'lock' && (<>
            <Segmented value={lockMode} onChange={setLockMode} options={[{ value: 'lock', label: 'Add a password' }, { value: 'unlock', label: 'Remove the password' }]} />
            {lockMode === 'lock' ? (<>
              <TextInput type="password" value={newPw} onChange={setNewPw} placeholder="Choose a password" />
              <div className="hint">AES-256 encryption. If you forget the password it cannot be recovered.</div>
              <Button variant="primary" icon="lock" disabled={!newPw} onClick={() => go({ kind: 'lock-pdf', opts: { newPassword: newPw, password: pdf.pw } })}>Lock PDF</Button></>) : (<>
              <TextInput type="password" value={pdf.pw} onChange={pdf.setPw} placeholder="Current password" />
              <Button variant="primary" icon="unlock" onClick={() => go({ kind: 'unlock-pdf', opts: { password: pdf.pw } })}>Unlock PDF</Button></>)}
          </>)}
          {tab === 'wm' && (<>
            <Segmented value={wm.type} onChange={(v) => setWm({ ...wm, type: v })} options={[{ value: 'text', label: 'Text' }, { value: 'image', label: 'Logo / image' }]} />
            {wm.type === 'text' ? <TextInput value={wm.text} onChange={(v) => setWm({ ...wm, text: v })} placeholder="Watermark text" /> : (
              <div className="row"><div className="path-box grow">{wm.imagePath ? wm.imagePath.split(/[\\/]/).pop() : 'No image chosen'}</div><Button size="sm" icon="image" onClick={async () => { try { const p = await api.pick({ filters: FILTERS.image }); if (p[0]) setWm({ ...wm, imagePath: p[0] }); } catch (e) { toast(errorText(e, 'That image could not be chosen.'), 'error'); } }}>Choose</Button></div>)}
            <div className="lbl">Placement</div>
            <Segmented small value={wm.position} onChange={(v) => setWm({ ...wm, position: v })} options={[{ value: 'center', label: 'Diagonal center' }, { value: 'tile', label: 'Repeat' }, { value: 'br', label: 'Corner' }]} />
            <Slider label="Opacity" value={wm.opacity} min={5} max={100} onChange={(v) => setWm({ ...wm, opacity: v })} format={(v) => v + '%'} />
            <Slider label="Size" value={wm.size} min={10} max={100} onChange={(v) => setWm({ ...wm, size: v })} format={(v) => v + '%'} />
            <Button variant="primary" icon="drop" onClick={() => { if (wm.type === 'image' && !wm.imagePath) { toast('Choose an image first', 'error'); return; } go({ kind: 'watermark-pdf', watermark: wm, opts: common }); }}>Add watermark</Button>
          </>)}
        </Card>
      )}
    </>
  );
}

export default function PdfTools() {
  const [tab, setTab] = useState('organize');
  const pdf = usePdf();
  const { toast } = useApp();
  const pick = async () => {
    try { const p = await api.pick({ filters: FILTERS.pdf }); if (p.length) await pdf.load(p); }
    catch (e) { toast(errorText(e, 'That PDF could not be chosen.'), 'error'); }
  };
  const single = !['merge', 'fromimg'].includes(tab);
  const loadDropped = useCallback((paths) => pdf.load(paths), [pdf.load]);
  // Merge/from-images tabs register their own drop handler.
  useDrop(single ? loadDropped : null);
  return (
    <div className="page">
      <PageHeader title="PDF Tools" sub="Everything for PDFs, on your computer. No uploads, no limits." />
      <div className="tabs-scroll">
        {TABS.map((t) => (
          <button key={t.id} className={`tabbtn wide ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {tab === t.id && <motion.span layoutId="pdftab" className="tab-pill" transition={spring} />}<Icon name={t.icon} size={16} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
          {tab === 'organize' ? <Organize pdf={pdf} pick={pick} /> : tab === 'merge' || tab === 'fromimg' ? <MergeTab kind={tab} key={tab} /> : <SingleTab tab={tab} pdf={pdf} pick={pick} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
