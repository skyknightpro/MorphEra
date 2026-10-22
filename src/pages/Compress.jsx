import React, { useState, useCallback } from 'react';
import { api, parseSize, fmtBytes, extLabel, errorText } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Button, IconButton, Chip, Segmented, Card, PageHeader, Progress, motion, AnimatePresence, spring } from '../ui.jsx';
import { DropZone, FileThumb, Sizes, SizeTarget, QUICK_SIZES, pickAndDescribe, FILTERS, Compare } from '../pagekit.jsx';

let uid = 0;
const OK = new Set(['image', 'video', 'audio']);

export default function Compress() {
  const { run, toast, jobs, setDockOpen } = useApp();
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState('target');
  const [tv, setTv] = useState('200');
  const [tu, setTu] = useState('KB');
  const [level, setLevel] = useState('medium');
  const [cmp, setCmp] = useState(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback((list) => {
    const ok = list.filter((f) => (OK.has(f.category) || f.ext === 'pdf') && f.supported);
    if (ok.length !== list.length) toast('Only images, video, audio and PDF can be compressed', 'error');
    setFiles((cur) => { const have = new Set(cur.map((f) => f.path)); return [...cur, ...ok.filter((f) => !have.has(f.path)).map((f) => ({ ...f, id: ++uid, jobId: null }))]; });
  }, [toast]);
  const addPaths = useCallback(async (paths) => {
    try { add(await api.describe(paths)); }
    catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  }, [add, toast]);
  useDrop(addPaths);
  const pick = async () => {
    try { add(await pickAndDescribe(FILTERS.compress)); }
    catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  };

  const targetBytes = mode === 'target' ? parseSize(tv, tu.toLowerCase()) : 0;
  const optsFor = (f) => ({ targetBytes, quality: level === 'light' ? 88 : level === 'strong' ? 55 : 72, level, crf: level === 'light' ? 24 : level === 'strong' ? 32 : 28, height: 0 });

  const start = async (list) => {
    if (mode === 'target' && !targetBytes) { toast('Type the size you need, for example 200 KB', 'error'); return; }
    try {
      const specs = list.map((f) => ({ kind: 'compress', file: f.path, opts: optsFor(f) }));
      const ids = await run(specs, list.map((f) => ({ name: f.name, to: '', srcSize: f.size, t: Date.now() })));
      setFiles((fs) => fs.map((f) => { const i = list.findIndex((x) => x.id === f.id); return i >= 0 ? { ...f, jobId: ids[i] } : f; }));
      if (list.length > 1) setDockOpen(true);
    } catch (e) { toast(errorText(e, 'The compression could not be started.'), 'error'); }
  };

  const preview = async (f) => {
    setBusy(true);
    try {
      const [before, trial] = await Promise.all([api.imagePreview(f.path, 1600), api.imageTrial({ kind: 'compress', file: f.path, opts: optsFor(f) })]);
      setCmp({ f, before: before.dataUrl, after: trial.preview, size: trial.size });
    } catch (e) { toast(errorText(e, 'Could not build a preview'), 'error'); } finally { setBusy(false); }
  };

  const pending = files.filter((f) => !f.jobId || ['error', 'cancelled'].includes((jobs[f.jobId] || {}).status));

  return (
    <div className="page">
      <PageHeader title="Compress" sub="Shrink anything to the exact size you need — images, video, audio and PDF." right={files.length > 0 && <Button variant="ghost" icon="trash" onClick={() => setFiles([])}>Clear</Button>} />
      <Card className="compress-bar">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'target', label: 'Exact size' }, { value: 'level', label: 'Quality level' }]} />
        {mode === 'target' ? (
          <div className="compress-target">
            <SizeTarget fixed enabled value={tv} onValue={setTv} unit={tu} onUnit={setTu} label="Make it smaller than" />
            <div className="chips">{QUICK_SIZES.map((q) => <Chip key={q.label} small active={tv === q.v && tu === q.u} onClick={() => { setTv(q.v); setTu(q.u); }}>{q.label}</Chip>)}</div>
            <div className="hint">MorphEra tunes quality automatically and only shrinks dimensions if it has to.</div>
          </div>
        ) : (
          <div className="compress-target">
            <Segmented small value={level} onChange={setLevel} options={[{ value: 'light', label: 'Light' }, { value: 'medium', label: 'Balanced' }, { value: 'strong', label: 'Strong' }]} />
            <div className="hint">{{ light: 'Barely visible loss. Best for photos you will keep.', medium: 'Great for sharing. Noticeably smaller, still sharp.', strong: 'Smallest files. Some detail is lost.' }[level]}</div>
          </div>
        )}
      </Card>

      {files.length === 0 ? <DropZone onPick={pick} title="Drop files to compress" icon="compress" /> : (
        <>
          <div className="toolbar"><Button icon="plus" onClick={pick}>Add more</Button></div>
          <div className="flist">
            <AnimatePresence initial={false}>
              {files.map((f) => {
                const job = f.jobId ? jobs[f.jobId] : null;
                const running = job && ['running', 'queued'].includes(job.status);
                const done = job && job.status === 'done';
                return (
                  <motion.div key={f.id} layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30 }} transition={spring} className={`frow glass ${done ? 'done' : ''}`}>
                    <FileThumb file={f} />
                    <div className="frow-main">
                      <div className="frow-name">{f.name}</div>
                      <div className="frow-meta"><span className="tag">{extLabel(f.ext)}</span><Sizes before={f.size} after={done ? job.sizeOut : 0} /></div>
                      {running && <div className="frow-prog"><Progress value={job.progress} /><span>{job.label} · {Math.round(job.progress * 100)}%</span></div>}
                      {job && job.status === 'error' && <div className="job-sub bad">{job.error}</div>}
                      {done && job.note && <div className="job-sub warn">{job.note}</div>}
                    </div>
                    <div className="frow-targets right">
                      {f.category === 'image' && !done && <Button size="sm" variant="soft" icon="eye" disabled={busy} onClick={() => preview(f)}>Preview</Button>}
                      {done && <Button size="sm" variant="soft" icon="folder" onClick={() => api.show(job.outputs[0])}>Show</Button>}
                    </div>
                    <div className="frow-end">{running ? <IconButton icon="x" title="Cancel" onClick={() => api.cancel(job.id)} size={16} /> : <IconButton icon="trash" title="Remove" onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))} size={16} />}</div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          <div className="actionbar glass"><div className="ab-info"><b>{files.length}</b> file{files.length > 1 ? 's' : ''}</div><div className="grow" />
            <Button variant="primary" icon="compress" disabled={!pending.length} onClick={() => start(pending)}>{pending.length > 1 ? `Compress ${pending.length} files` : 'Compress'}</Button></div>
        </>
      )}

      <AnimatePresence>
        {cmp && (
          <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCmp(null)}>
            <motion.div className="modal glass" initial={{ scale: 0.94, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} transition={spring} onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><b>Before & after</b><span className="muted">{fmtBytes(cmp.f.size)} → <b className="good">{fmtBytes(cmp.size)}</b></span><div className="grow" /><IconButton icon="x" title="Close" onClick={() => setCmp(null)} /></div>
              <Compare before={cmp.before} after={cmp.after} labelA={`Original · ${fmtBytes(cmp.f.size)}`} labelB={`Compressed · ${fmtBytes(cmp.size)}`} />
              <div className="modal-foot"><Button variant="primary" icon="compress" onClick={() => { const f = cmp.f; setCmp(null); start([f]); }}>Looks good, compress</Button></div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
