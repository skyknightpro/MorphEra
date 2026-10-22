import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, fmtBytes, parseSize } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Icon, Button, IconButton, Chip, Segmented, Slider, Toggle, PageHeader, TextInput, motion, AnimatePresence, spring } from '../ui.jsx';
import { DropZone, FILTERS, SizeTarget, Compare } from '../pagekit.jsx';

const RATIOS = [{ id: 'free', label: 'Free', r: 0 }, { id: 'orig', label: 'Original', r: -1 }, { id: '1:1', label: '1:1', r: 1 }, { id: '4:3', label: '4:3', r: 4 / 3 }, { id: '3:2', label: '3:2', r: 3 / 2 }, { id: '16:9', label: '16:9', r: 16 / 9 }, { id: '9:16', label: '9:16', r: 9 / 16 }, { id: '3:4', label: '3:4', r: 3 / 4 }];
const POS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
const posKey = (p) => ({ tl: 'tl', tc: 't', tr: 'tr', cl: 'l', cc: 'center', cr: 'r', bl: 'bl', bc: 'b', br: 'br' }[p]);

function CropBox({ box, setBox, stage, ratio }) {
  // box in stage pixels {x,y,w,h}
  const drag = useRef(null);
  const start = (mode) => (e) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, b: { ...box } };
    const mv = (ev) => {
      const d = drag.current; if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      let { x, y, w, h } = d.b;
      const min = 24;
      if (d.mode === 'move') { x = Math.max(0, Math.min(stage.w - w, x + dx)); y = Math.max(0, Math.min(stage.h - h, y + dy)); }
      else {
        let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
        if (d.mode.includes('l')) x0 = Math.min(x1 - min, Math.max(0, x0 + dx));
        if (d.mode.includes('r')) x1 = Math.max(x0 + min, Math.min(stage.w, x1 + dx));
        if (d.mode.includes('t')) y0 = Math.min(y1 - min, Math.max(0, y0 + dy));
        if (d.mode.includes('b')) y1 = Math.max(y0 + min, Math.min(stage.h, y1 + dy));
        w = x1 - x0; h = y1 - y0;
        if (ratio > 0) {
          const horiz = d.mode.includes('l') || d.mode.includes('r');
          const vert = d.mode.includes('t') || d.mode.includes('b');
          if (horiz && !vert) h = w / ratio; else if (vert && !horiz) w = h * ratio; else if (w / h > ratio) w = h * ratio; else h = w / ratio;
          if (d.mode.includes('l')) x0 = x1 - w; else x1 = x0 + w;
          if (d.mode.includes('t')) y0 = y1 - h; else y1 = y0 + h;
          if (x0 < 0) { x0 = 0; w = x1; h = w / ratio; if (d.mode.includes('t')) y0 = y1 - h; else y1 = y0 + h; }
          if (y0 < 0) { y0 = 0; h = y1; w = h * ratio; if (d.mode.includes('l')) x0 = x1 - w; else x1 = x0 + w; }
          if (x1 > stage.w) { x1 = stage.w; w = x1 - x0; h = w / ratio; if (d.mode.includes('t')) y0 = y1 - h; else y1 = y0 + h; }
          if (y1 > stage.h) { y1 = stage.h; h = y1 - y0; w = h * ratio; if (d.mode.includes('l')) x0 = x1 - w; else x1 = x0 + w; }
        }
        x = x0; y = y0; w = x1 - x0; h = y1 - y0;
      }
      setBox({ x, y, w, h });
    };
    const up = () => { drag.current = null; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const H = ['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'];
  return (
    <div className="crop" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onPointerDown={start('move')}>
      <div className="crop-grid" />
      {H.map((h) => <span key={h} className={`handle ${h}`} onPointerDown={start(h)} />)}
    </div>
  );
}

function fitRect(box, ratio, stage) {
  let w = stage.w, h = stage.h;
  if (ratio > 0) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
  w *= 0.9; h *= 0.9;
  return { x: (stage.w - w) / 2, y: (stage.h - h) / 2, w, h };
}

const DEF = { rot: 0, fx: false, fy: false, crop: false, ratio: 'free', resizeMode: 'none', pct: 50, maxEdge: 1600, rw: '', rh: '', fit: 'inside', up: 1, sharpen: 0, denoise: false, removeBg: false, wm: false, wmType: 'text', wmText: '© MorphEra', wmImg: '', wmPos: 'br', wmOpacity: 60, wmSize: 30, strip: false, to: 'jpg', quality: 90, target: false, tv: '500', tu: 'KB' };

export default function ImageStudio() {
  const { info, run, toast, setDockOpen } = useApp();
  const bgReady = !!(info && info.features && info.features.backgroundRemoval);
  const [file, setFile] = useState(null);
  const [prev, setPrev] = useState(null);
  const [s, setS] = useState(DEF);
  const [tab, setTab] = useState('crop');
  const [box, setBox] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef(null);
  const [avail, setAvail] = useState({ w: 600, h: 420 });
  const set = (p) => setS((x) => ({ ...x, ...p }));
  const fail = useCallback((e) => toast(String((e && e.message) || e || 'Something went wrong').replace(/^Error invoking remote method '[^']+': Error: /, ''), 'error'), [toast]);

  const open = useCallback(async (paths) => {
    let tentative = false;
    try {
      const d = (await api.describe(paths)).filter((x) => x.category === 'image');
      if (!d.length) { toast('Please choose an image', 'error'); return; }
      const f = d[0];
      tentative = true;
      setFile(f); setPrev(null); setBox(null); setCmp(null);
      const p = await api.imagePreview(f.path, 1800);
      if (!p || !p.dataUrl) throw new Error('This image could not be previewed.');
      setPrev(p);
      const same = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico'].includes(f.ext) ? f.ext : 'png';
      setS({ ...DEF, to: f.ext === 'heic' ? 'jpg' : same, strip: false });
    } catch (e) {
      if (tentative) { setFile(null); setPrev(null); setBox(null); setCmp(null); }
      fail(e);
    }
  }, [toast, fail]);
  useDrop(open);
  const pick = async () => {
    try { const p = await api.pick({ filters: FILTERS.image }); if (p && p.length) await open(p); }
    catch (e) { fail(e); }
  };

  // available stage size
  useEffect(() => {
    if (!stageRef.current) return;
    const ro = new ResizeObserver(() => { const r = stageRef.current.getBoundingClientRect(); setAvail({ w: r.width - 40, h: r.height - 40 }); });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [file]);

  const swap = s.rot % 180 !== 0;
  const nat = prev ? { w: swap ? prev.height : prev.width, h: swap ? prev.width : prev.height } : { w: 1, h: 1 };
  const scale = Math.min(avail.w / nat.w, avail.h / nat.h, 1.5);
  const stage = { w: Math.max(40, nat.w * scale), h: Math.max(40, nat.h * scale) };

  const ratioVal = useMemo(() => { const r = RATIOS.find((x) => x.id === s.ratio); if (!r) return 0; return r.r === -1 ? nat.w / nat.h : r.r; }, [s.ratio, nat.w, nat.h]);

  // reset crop box when enabled or geometry changes
  useEffect(() => { if (s.crop && prev) setBox(fitRect(null, ratioVal, stage)); }, [s.crop, s.ratio, s.rot, prev, avail.w, avail.h]); // eslint-disable-line

  const cropPx = () => {
    if (!s.crop || !box || !prev) return null;
    const k = nat.w / stage.w; // stage px -> original image px
    return { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k };
  };
  const cropOut = cropPx();
  const finalSize = useMemo(() => {
    if (!prev) return null;
    let w = nat.w, h = nat.h;
    if (cropOut) { w = cropOut.w; h = cropOut.h; }
    if (s.resizeMode === 'percent') { w *= s.pct / 100; h *= s.pct / 100; }
    else if (s.resizeMode === 'maxEdge') { const m = Math.max(w, h); if (m > s.maxEdge) { w *= s.maxEdge / m; h *= s.maxEdge / m; } }
    else if (s.resizeMode === 'exact') {
      const rw = parseInt(s.rw, 10), rh = parseInt(s.rh, 10);
      if (rw && rh) { if (s.fit === 'inside') { const k = Math.min(rw / w, rh / h); w *= k; h *= k; } else { w = rw; h = rh; } }
      else if (rw) { h *= rw / w; w = rw; } else if (rh) { w *= rh / h; h = rh; }
    }
    if (s.up > 1) { w *= s.up; h *= s.up; }
    return { w: Math.round(w), h: Math.round(h) };
  }, [prev, cropOut && cropOut.w, cropOut && cropOut.h, s.resizeMode, s.pct, s.maxEdge, s.rw, s.rh, s.fit, s.up, nat.w, nat.h]); // eslint-disable-line

  const buildEdits = () => {
    const e = { rotate: s.rot, flipH: s.fx, flipV: s.fy };
    const c = cropPx(); if (c) e.crop = c;
    if (s.resizeMode === 'percent') e.resize = { mode: 'percent', percent: s.pct };
    if (s.resizeMode === 'maxEdge') e.resize = { mode: 'maxEdge', maxEdge: s.maxEdge };
    if (s.resizeMode === 'exact') e.resize = { mode: 'exact', width: parseInt(s.rw, 10) || 0, height: parseInt(s.rh, 10) || 0, fit: s.fit };
    if (s.up > 1 || s.sharpen > 0 || s.denoise) e.enhance = { upscale: s.up, sharpen: s.sharpen / 100, denoise: s.denoise };
    if (s.removeBg) e.removeBg = true;
    if (s.wm) e.watermark = { type: s.wmType, text: s.wmText, imagePath: s.wmImg, position: posKey(s.wmPos), opacity: s.wmOpacity, size: s.wmSize };
    return e;
  };
  const buildSpec = () => ({ kind: 'edit-image', file: file.path, to: s.removeBg && ['jpg', 'bmp'].includes(s.to) ? 'png' : s.to, edits: buildEdits(), opts: { quality: s.quality, stripMeta: s.strip, targetBytes: s.target ? parseSize(s.tv, s.tu.toLowerCase()) : 0 } });

  const save = async () => {
    if (!file || !prev) { toast('Open an image first', 'error'); return; }
    if (s.removeBg && !bgReady) { toast('Background removal is not available in this build. Reinstall MorphEra to restore it.', 'error'); return; }
    if (s.wm && s.wmType === 'image' && !s.wmImg) { toast('Choose a watermark image first', 'error'); return; }
    const spec = buildSpec();
    try {
      await run([spec], [{ name: file.name, to: spec.to, srcSize: file.size, t: Date.now() }]);
      setDockOpen(true);
    } catch (e) { fail(e); }
  };
  const preview = async () => {
    if (!file || !prev) return;
    if (s.removeBg && !bgReady) { toast('Background removal is not available in this build. Reinstall MorphEra to restore it.', 'error'); return; }
    if (s.wm && s.wmType === 'image' && !s.wmImg) { toast('Choose a watermark image first', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.imageTrial(buildSpec());
      setCmp({ before: prev.dataUrl, after: r.preview, size: r.size, w: r.width, h: r.height });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const TABS = [['crop', 'crop', 'Crop'], ['transform', 'rotate', 'Rotate'], ['resize', 'grid', 'Resize'], ['enhance', 'wand', 'Enhance'], ['bg', 'eraser', 'Background'], ['wm', 'drop', 'Watermark'], ['export', 'download', 'Export']];

  if (!file) return (
    <div className="page">
      <PageHeader title="Image Studio" sub="Crop, rotate, resize, enhance, remove backgrounds and add watermarks." />
      <DropZone onPick={pick} title="Drop an image to start editing" icon="image" hint="JPG · PNG · WEBP · HEIC · AVIF · GIF · TIFF · SVG" />
    </div>
  );

  return (
    <div className="page studio">
      <PageHeader title="Image Studio" sub={`${file.name} · ${prev ? `${prev.width} × ${prev.height}` : 'loading'} · ${fmtBytes(file.size)}`} right={<Button variant="ghost" icon="plus" onClick={pick}>Open another</Button>} />
      <div className="studio-grid">
        <div className="studio-stage glass" ref={stageRef}>
          {!prev ? <div className="muted">Loading preview…</div> : (
            <div className="stage-box" style={{ width: stage.w, height: stage.h }}>
              <div className="checker" />
              <img src={prev.dataUrl} alt="" draggable={false} style={{ position: 'absolute', left: '50%', top: '50%', width: (swap ? stage.h : stage.w), height: (swap ? stage.w : stage.h), transform: `translate(-50%,-50%) scaleX(${s.fx ? -1 : 1}) scaleY(${s.fy ? -1 : 1}) rotate(${s.rot}deg)`, transition: 'transform .35s cubic-bezier(.2,.8,.2,1)' }} />
              {s.crop && box && <div className="crop-dim" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${box.x}px ${box.y}px,${box.x}px ${box.y + box.h}px,${box.x + box.w}px ${box.y + box.h}px,${box.x + box.w}px ${box.y}px,${box.x}px ${box.y}px)` }} />}
              {s.crop && box && <CropBox box={box} setBox={setBox} stage={stage} ratio={ratioVal} />}
            </div>
          )}
          {finalSize && <div className="stage-badge glass">Output {finalSize.w} × {finalSize.h}</div>}
        </div>

        <div className="studio-panel glass">
          <div className="tabs">
            {TABS.map(([id, ic, lb]) => (
              <button key={id} className={`tabbtn ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)} title={lb}>
                {tab === id && <motion.span layoutId="studiotab" className="tab-pill" transition={spring} />}<Icon name={ic} size={17} /><span>{lb}</span>
              </button>
            ))}
          </div>
          <div className="panel-body">
            <div className="panel-title">{TABS.find((t) => t[0] === tab)[2]}</div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }}>
                {tab === 'crop' && (<>
                  <Toggle checked={s.crop} onChange={(v) => set({ crop: v })} label="Crop" hint="Drag the box on the picture" />
                  <div className="lbl">Shape</div>
                  <div className="chips">{RATIOS.map((r) => <Chip key={r.id} small active={s.ratio === r.id} onClick={() => set({ ratio: r.id, crop: true })}>{r.label}</Chip>)}</div>
                </>)}
                {tab === 'transform' && (<>
                  <div className="lbl">Rotate</div>
                  <div className="btnrow"><Button icon="rotate" onClick={() => set({ rot: (s.rot + 270) % 360, crop: false })}>Left</Button><Button icon="rotate" onClick={() => set({ rot: (s.rot + 90) % 360, crop: false })}>Right</Button></div>
                  <div className="lbl">Flip</div>
                  <div className="btnrow"><Button icon="flipH" variant={s.fx ? 'primary' : 'soft'} onClick={() => set({ fx: !s.fx })}>Horizontal</Button><Button icon="flipV" variant={s.fy ? 'primary' : 'soft'} onClick={() => set({ fy: !s.fy })}>Vertical</Button></div>
                  {(s.rot || s.fx || s.fy) ? <Button variant="ghost" size="sm" onClick={() => set({ rot: 0, fx: false, fy: false })}>Reset</Button> : null}
                </>)}
                {tab === 'resize' && (<>
                  <Segmented small value={s.resizeMode} onChange={(v) => set({ resizeMode: v })} options={[{ value: 'none', label: 'Original' }, { value: 'percent', label: 'Percent' }, { value: 'maxEdge', label: 'Longest side' }, { value: 'exact', label: 'Exact' }]} />
                  {s.resizeMode === 'percent' && <Slider label="Scale" value={s.pct} min={5} max={200} onChange={(v) => set({ pct: v })} format={(v) => v + '%'} />}
                  {s.resizeMode === 'maxEdge' && (<><div className="chips">{[512, 1024, 1600, 1920, 2560, 3840].map((v) => <Chip key={v} small active={s.maxEdge === v} onClick={() => set({ maxEdge: v })}>{v}px</Chip>)}</div><Slider label="Longest side" value={s.maxEdge} min={64} max={6000} step={16} onChange={(v) => set({ maxEdge: v })} format={(v) => v + ' px'} /></>)}
                  {s.resizeMode === 'exact' && (<div className="exact"><TextInput value={s.rw} onChange={(v) => set({ rw: v.replace(/\D/g, '') })} placeholder="Width" suffix="px" /><span className="muted">×</span><TextInput value={s.rh} onChange={(v) => set({ rh: v.replace(/\D/g, '') })} placeholder="Height" suffix="px" />
                    <div className="lbl full">When the shape differs</div><Segmented small value={s.fit} onChange={(v) => set({ fit: v })} options={[{ value: 'inside', label: 'Keep proportions' }, { value: 'cover', label: 'Fill & crop' }, { value: 'fill', label: 'Stretch' }]} /></div>)}
                </>)}
                {tab === 'enhance' && (<>
                  <div className="lbl">Upscale</div>
                  <Segmented small value={String(s.up)} onChange={(v) => set({ up: Number(v) })} options={[{ value: '1', label: 'Off' }, { value: '2', label: '2×' }, { value: '3', label: '3×' }, { value: '4', label: '4×' }]} />
                  <Slider label="Sharpen" value={s.sharpen} min={0} max={100} onChange={(v) => set({ sharpen: v })} format={(v) => v + '%'} />
                  <Toggle checked={s.denoise} onChange={(v) => set({ denoise: v })} label="Reduce noise" hint="Smooths grain in dark photos" />
                </>)}
                {tab === 'bg' && (<>
                  <Toggle checked={s.removeBg && bgReady} disabled={!bgReady} onChange={(v) => set({ removeBg: v, to: v && ['jpg', 'bmp'].includes(s.to) ? 'png' : s.to })} label="Remove background" hint={bgReady ? 'Runs on your computer. The result is saved with a transparent background (PNG or WEBP).' : 'Background removal is not available in this build. Reinstall MorphEra to restore it.'} />
                  {!bgReady && <div className="hint">You can still crop, resize and convert images. Only background removal needs the extra model files.</div>}
                </>)}
                {tab === 'wm' && (<>
                  <Toggle checked={s.wm} onChange={(v) => set({ wm: v })} label="Add a watermark" />
                  <Segmented small value={s.wmType} onChange={(v) => set({ wmType: v, wm: true })} options={[{ value: 'text', label: 'Text' }, { value: 'image', label: 'Logo / image' }]} />
                  {s.wmType === 'text' ? <TextInput value={s.wmText} onChange={(v) => set({ wmText: v, wm: true })} placeholder="Your text" /> : <div className="row"><div className="path-box grow">{s.wmImg ? s.wmImg.split(/[\\/]/).pop() : 'No image chosen'}</div><Button size="sm" icon="image" onClick={async () => { try { const p = await api.pick({ filters: FILTERS.image }); if (p[0]) set({ wmImg: p[0], wm: true }); } catch (e) { fail(e); } }}>Choose</Button></div>}
                  <div className="lbl">Position</div>
                  <div className="posgrid">{POS.map((p) => <button key={p} className={s.wmPos === p ? 'on' : ''} onClick={() => set({ wmPos: p, wm: true })} aria-label={p} />)}</div>
                  <Slider label="Opacity" value={s.wmOpacity} min={10} max={100} onChange={(v) => set({ wmOpacity: v })} format={(v) => v + '%'} />
                  <Slider label="Size" value={s.wmSize} min={5} max={80} onChange={(v) => set({ wmSize: v })} format={(v) => v + '%'} />
                </>)}
                {tab === 'export' && (<>
                  <div className="lbl">Save as</div>
                  <div className="chips">{['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf'].map((f) => <Chip key={f} small active={s.to === f} onClick={() => set({ to: f })}>{f.toUpperCase()}</Chip>)}</div>
                  <Slider label="Quality" value={s.quality} min={30} max={100} onChange={(v) => set({ quality: v })} format={(v) => v + '%'} disabled={s.target || ['png', 'gif', 'bmp', 'ico', 'pdf'].includes(s.to)} />
                  <SizeTarget enabled={s.target} onEnable={(v) => set({ target: v })} value={s.tv} onValue={(v) => set({ tv: v })} unit={s.tu} onUnit={(v) => set({ tu: v })} label="Limit file size" />
                  <Toggle checked={s.strip} onChange={(v) => set({ strip: v })} label="Remove private info (EXIF)" hint="Location, camera model and date" />
                </>)}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="panel-foot">
            <Button variant="soft" icon="eye" disabled={busy || !prev} onClick={preview}>{busy ? 'Working…' : 'Preview result'}</Button>
            <Button variant="primary" icon="download" onClick={save} disabled={!prev}>Save</Button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {cmp && (
          <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCmp(null)}>
            <motion.div className="modal glass" initial={{ scale: 0.94, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} transition={spring} onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><b>Before & after</b><span className="muted">{fmtBytes(file.size)} → <b className="good">{fmtBytes(cmp.size)}</b> · {cmp.w} × {cmp.h}</span><div className="grow" /><IconButton icon="x" title="Close" onClick={() => setCmp(null)} /></div>
              <Compare before={cmp.before} after={cmp.after} />
              <div className="modal-foot"><Button variant="primary" icon="download" onClick={() => { setCmp(null); save(); }}>Save this</Button></div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
