import React, { useState, useMemo, useCallback } from 'react';
import { api, parseSize, extLabel, errorText } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Icon, Button, IconButton, Chip, Segmented, Slider, Toggle, Card, PageHeader, Progress, Select, motion, AnimatePresence, spring } from '../ui.jsx';
import { DropZone, FileThumb, Sizes, SizeTarget, QUICK_SIZES, pickAndDescribe } from '../pagekit.jsx';

let uid = 0;

function Row({ f, job, onTo, onRemove, onRetry, expanded, onExpand, onlyDone }) {
  const running = job && (job.status === 'running' || job.status === 'queued');
  const done = job && job.status === 'done';
  const err = job && job.status === 'error';
  const sug = f.suggest || [];
  const rest = f.targets.filter((t) => !sug.includes(t.ext));
  const outSize = job && job.sizeOut;
  return (
    <motion.div layout initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: -30, scale: 0.97 }} transition={spring} className={`frow glass ${done ? 'done' : ''} ${err ? 'err' : ''}`}>
      <FileThumb file={f} />
      <div className="frow-main">
        <div className="frow-name" title={f.path}>{f.name}</div>
        <div className="frow-meta"><span className="tag">{extLabel(f.ext)}</span><Sizes before={f.size} after={done ? outSize : 0} /></div>
        {running && <div className="frow-prog"><Progress value={job.progress} /><span>{job.label} · {Math.round(job.progress * 100)}%</span></div>}
        {err && <div className="job-sub bad">{job.error}</div>}
        {done && job.note && <div className="job-sub warn">{job.note}</div>}
      </div>
      <div className="frow-targets">
        {!f.supported ? <span className="bad small">Not supported</span> : running ? (
          <span className="muted small">Converting…</span>
        ) : done ? (
          <div className="done-actions">
            <span className="good small"><Icon name="check" size={15} /> {extLabel(f.to)} ready</span>
            <Button size="sm" variant="soft" icon="folder" onClick={() => api.show(job.outputs[0])}>Show</Button>
          </div>
        ) : (
          <>
            <span className="to-label">to</span>
            {sug.map((e) => <Chip key={e} active={f.to === e} onClick={() => onTo(e)} tone="sug">{extLabel(e)}</Chip>)}
            {rest.length > 0 && (
              <div className="more">
                <Select small value={rest.some((t) => t.ext === f.to) ? f.to : ''} onChange={(v) => v && onTo(v)} options={[{ value: '', label: 'More…' }, ...rest.map((t) => ({ value: t.ext, label: extLabel(t.ext) + (t.office ? ' (needs LibreOffice)' : '') }))]} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="frow-end">
        {err && <IconButton icon="refresh" title="Try again" onClick={onRetry} size={16} />}
        {running ? <IconButton icon="x" title="Cancel" onClick={() => api.cancel(job.id)} size={16} /> : <IconButton icon="trash" title="Remove" onClick={onRemove} size={16} />}
      </div>
    </motion.div>
  );
}

export default function Convert() {
  const { info, run, toast, jobs, setDockOpen } = useApp();
  const [files, setFiles] = useState([]);
  const [preset, setPreset] = useState('');
  const [showOpts, setShowOpts] = useState(false);
  const [o, setO] = useState({ quality: 85, target: false, tv: '300', tu: 'KB', res: 'source', vq: 'balanced', abr: 192, strip: false, ocr: 'auto', exact: false });
  const set = (p) => setO((x) => ({ ...x, ...p }));

  const add = useCallback((list) => {
    setFiles((cur) => {
      const have = new Set(cur.map((f) => f.path));
      const next = list.filter((f) => !have.has(f.path)).map((f) => ({ ...f, id: ++uid, to: f.suggest[0] || (f.targets[0] && f.targets[0].ext) || '', jobId: null }));
      return [...cur, ...next];
    });
  }, []);
  const addPaths = useCallback(async (paths) => {
    try {
      const d = await api.describe(paths);
      const bad = d.filter((x) => !x.supported).length;
      if (bad) toast(`${bad} file${bad > 1 ? 's' : ''} skipped: format not supported`, 'error');
      add(d.filter((x) => x.supported));
    } catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  }, [add, toast]);
  useDrop(addPaths);

  const pick = async () => {
    try {
      const d = await pickAndDescribe();
      const ok = d.filter((x) => x.supported);
      if (d.length - ok.length) toast('Some files are not supported', 'error');
      add(ok);
    } catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  };

  const cats = useMemo(() => new Set(files.map((f) => f.category)), [files]);
  const common = useMemo(() => {
    if (!files.length) return [];
    const sets = files.filter((f) => f.supported).map((f) => new Set(f.targets.map((t) => t.ext)));
    if (!sets.length) return [];
    return [...sets[0]].filter((e) => sets.every((s) => s.has(e)));
  }, [files]);
  const applyAll = (e) => setFiles((fs) => fs.map((f) => (f.targets.some((t) => t.ext === e) ? { ...f, to: e } : f)));

  const buildSpec = (f) => {
    const opts = {};
    const targetBytes = o.target ? parseSize(o.tv, o.tu.toLowerCase()) : 0;
    if (f.category === 'image') Object.assign(opts, { quality: o.quality, stripMeta: o.strip, targetBytes });
    if (f.category === 'video') Object.assign(opts, { height: o.res === 'source' ? 0 : Number(o.res), crf: { fast: 28, balanced: 23, best: 18 }[o.vq], targetBytes });
    if (f.category === 'audio') Object.assign(opts, { audioBitrate: o.abr, targetBytes });
    if (f.ext === 'pdf') Object.assign(opts, { forceOcr: o.ocr === 'always', ocr: o.ocr !== 'never', exactLayout: o.exact });
    return { kind: 'convert', file: f.path, to: f.to, preset: preset || undefined, opts, edits: {} };
  };

  const start = async (list) => {
    const todo = list.filter((f) => f.supported && f.to);
    if (!todo.length) return;
    try {
      const specs = todo.map(buildSpec);
      const ids = await run(specs, todo.map((f) => ({ name: f.name, to: f.to, srcSize: f.size, t: Date.now() })));
      setFiles((fs) => fs.map((f) => { const i = todo.findIndex((x) => x.id === f.id); return i >= 0 ? { ...f, jobId: ids[i], doneTo: f.to } : f; }));
      if (todo.length > 1) setDockOpen(true);
    } catch (e) { toast(errorText(e, 'The conversion could not be started.'), 'error'); }
  };

  const pending = files.filter((f) => f.supported && (!f.jobId || ['error', 'cancelled'].includes((jobs[f.jobId] || {}).status)));
  const hasVideo = cats.has('video'), hasImg = cats.has('image'), hasAudio = cats.has('audio'), hasPdf = files.some((f) => f.ext === 'pdf');
  const canTarget = hasImg || hasVideo || hasAudio;
  const allDone = files.length > 0 && files.every((f) => f.jobId && (jobs[f.jobId] || {}).status === 'done');
  const saveText = !info ? 'saved to your output folder'
    : info.outputNote ? 'saved to a writable folder'
      : info.settings.outputMode === 'folder' ? 'saved in the MorphEra Files folder'
        : info.settings.outputMode === 'custom' && info.settings.customOutput ? 'saved to your chosen folder'
          : 'saved next to MorphEra';

  return (
    <div className="page">
      <PageHeader title="Convert" sub="Drop anything. Pick a format. Done." right={files.length > 0 && <Button variant="ghost" icon="trash" onClick={() => setFiles([])}>Clear</Button>} />

      {files.length === 0 ? (
        <>
          <DropZone onPick={pick} title="Drop your files here" hint="Images · Video · Audio · PDF · Word · Excel · PowerPoint · and more" />
          <div className="tiles">
            {[['image', 'Images', 'JPG, PNG, WEBP, HEIC, AVIF, GIF…'], ['film', 'Video', 'MP4, MKV, MOV, AVI, WEBM → GIF'], ['music', 'Audio', 'MP3, WAV, FLAC, AAC, OGG, M4A'], ['file', 'Documents', 'PDF ⇄ Word, Excel, text, slides']].map(([ic, t, s], i) => (
              <motion.div key={t} className="tile glass" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 * i }} whileHover={{ y: -3 }}>
                <div className="tile-ico"><Icon name={ic} size={20} /></div><b>{t}</b><span>{s}</span>
              </motion.div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="toolbar">
            <Button variant="soft" icon="plus" onClick={pick}>Add more</Button>
            {common.length > 0 && files.length > 1 && (
              <div className="applyall"><span className="muted small">Convert all to</span>{common.slice(0, 8).map((e) => <Chip key={e} small onClick={() => applyAll(e)}>{extLabel(e)}</Chip>)}</div>
            )}
            <div className="grow" />
            <Button variant="ghost" icon="gear" onClick={() => setShowOpts(!showOpts)}>{showOpts ? 'Hide options' : 'Options'}</Button>
          </div>

          <AnimatePresence initial={false}>
            {showOpts && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28 }} style={{ overflow: 'hidden' }}>
                <Card className="opts">
                  <div className="opt-grid">
                    <div className="opt-col">
                      <div className="opt-title">Preset</div>
                      <div className="chips">
                        <Chip active={!preset} onClick={() => setPreset('')}>None</Chip>
                        {info && info.presets.map((p) => <Chip key={p.id} active={preset === p.id} onClick={() => setPreset(p.id)} title={p.blurb}>{p.label}</Chip>)}
                      </div>
                      <div className="hint">{preset && info ? info.presets.find((p) => p.id === preset).blurb : 'Choose a preset to optimize everything for WhatsApp, email, YouTube or print.'}</div>
                    </div>
                    {canTarget && (
                      <div className="opt-col">
                        <div className="opt-title">Size</div>
                        <SizeTarget enabled={o.target} onEnable={(v) => set({ target: v })} value={o.tv} onValue={(v) => set({ tv: v })} unit={o.tu} onUnit={(v) => set({ tu: v })} label="Fit each file under…" />
                        <div className="chips">{QUICK_SIZES.map((q) => <Chip key={q.label} small onClick={() => set({ target: true, tv: q.v, tu: q.u })}>{q.label}</Chip>)}</div>
                      </div>
                    )}
                    {hasImg && (
                      <div className="opt-col">
                        <div className="opt-title">Images</div>
                        <Slider label="Quality" value={o.quality} min={30} max={100} onChange={(v) => set({ quality: v })} format={(v) => v + '%'} disabled={o.target} />
                        <Toggle checked={o.strip} onChange={(v) => set({ strip: v })} label="Remove private info (EXIF)" hint="Location, camera and date are erased" />
                      </div>
                    )}
                    {hasVideo && (
                      <div className="opt-col">
                        <div className="opt-title">Video</div>
                        <div className="lbl">Resolution</div>
                        <Segmented small value={o.res} onChange={(v) => set({ res: v })} options={[{ value: 'source', label: 'Original' }, { value: '1080', label: '1080p' }, { value: '720', label: '720p' }, { value: '480', label: '480p' }]} />
                        <div className="lbl">Quality</div>
                        <Segmented small value={o.vq} onChange={(v) => set({ vq: v })} options={[{ value: 'fast', label: 'Smaller' }, { value: 'balanced', label: 'Balanced' }, { value: 'best', label: 'Best' }]} />
                      </div>
                    )}
                    {hasAudio && (
                      <div className="opt-col">
                        <div className="opt-title">Audio</div>
                        <Slider label="Bitrate" value={o.abr} min={64} max={320} step={32} onChange={(v) => set({ abr: v })} format={(v) => v + ' kbps'} disabled={o.target} />
                      </div>
                    )}
                    {hasPdf && (
                      <div className="opt-col">
                        <div className="opt-title">PDF → Word / text</div>
                        <div className="lbl">Scanned pages (OCR)</div>
                        <Segmented small value={o.ocr} onChange={(v) => set({ ocr: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Off' }]} />
                        <Toggle checked={o.exact} onChange={(v) => set({ exact: v })} label="Fixed layout" hint="Places every line exactly where it was. Less editable." />
                      </div>
                    )}
                  </div>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div className="flist" layout>
            <AnimatePresence initial={false}>
              {files.map((f) => (
                <Row key={f.id} f={f} job={f.jobId ? jobs[f.jobId] : null}
                  onTo={(e) => setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, to: e, jobId: x.jobId && ['done'].includes((jobs[x.jobId] || {}).status) ? null : x.jobId } : x)))}
                  onRemove={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))}
                  onRetry={() => start([f])} />
              ))}
            </AnimatePresence>
          </motion.div>

          <div className="actionbar glass">
            <div className="ab-info">
              <b>{files.length}</b> file{files.length > 1 ? 's' : ''}
              <span className="muted"> · {saveText}</span>
              {info && <button className="linkish" onClick={() => api.openOutput()}>Open folder</button>}
            </div>
            <div className="grow" />
            {allDone ? <Button variant="primary" icon="folder" onClick={() => api.openOutput()}>Open output folder</Button>
              : <Button variant="primary" icon="bolt" disabled={!pending.length} onClick={() => start(pending)}>{pending.length > 1 ? `Convert ${pending.length} files` : 'Convert'}</Button>}
          </div>
        </>
      )}
    </div>
  );
}
