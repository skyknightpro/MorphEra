import React, { useEffect, useState } from 'react';
import { api, fmtBytes, fmtDuration, errorText } from './api.js';
import { useApp } from './store.jsx';
import { Icon, Logo, IconButton, Progress, Button, motion, AnimatePresence, spring } from './ui.jsx';

export function TitleBar() {
  const { info, setSettings, toast } = useApp();
  const [max, setMax] = useState(false);
  useEffect(() => api.onWinState((s) => setMax(s.max)), []);
  const theme = (info && info.settings.theme) || 'dark';
  const toggleTheme = () => setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
    .catch((e) => toast(errorText(e, 'The theme could not be changed.'), 'error'));
  return (
    <div className="titlebar">
      <div className="tb-brand"><Logo size={22} /><span>MorphEra</span></div>
      <div className="tb-drag" onDoubleClick={() => api.win.max()} />
      <div className="tb-actions">
        <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} onClick={toggleTheme} />
        <div className="tb-sep" />
        <button className="wc" onClick={() => api.win.min()} aria-label="Minimize"><Icon name="minus" size={15} /></button>
        <button className="wc" onClick={() => api.win.max()} aria-label="Maximize"><Icon name={max ? 'restore' : 'square'} size={13} /></button>
        <button className="wc close" onClick={() => api.win.close()} aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}

const NAV = [
  { id: 'convert', label: 'Convert', icon: 'convert' },
  { id: 'compress', label: 'Compress', icon: 'compress' },
  { id: 'image', label: 'Image Studio', icon: 'image' },
  { id: 'media', label: 'Video & Audio', icon: 'film' },
  { id: 'pdf', label: 'PDF Tools', icon: 'file' },
  { id: 'presets', label: 'Presets', icon: 'bolt' },
  { id: 'watch', label: 'Watch Folder', icon: 'eye' },
];
const NAV2 = [
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

export function Sidebar() {
  const { route, setRoute, jobs, toggleDock, dockOpen } = useApp();
  const active = Object.values(jobs).filter((j) => j.status === 'running' || j.status === 'queued').length;
  const item = (n) => (
    <button key={n.id} className={`nav ${route === n.id ? 'on' : ''}`} onClick={() => setRoute(n.id)}>
      {route === n.id && <motion.span layoutId="navpill" className="nav-pill" transition={spring} />}
      <Icon name={n.icon} size={18} /><span>{n.label}</span>
    </button>
  );
  return (
    <aside className="sidebar glass">
      <nav>{NAV.map(item)}</nav>
      <div className="grow" />
      <button className={`queue-btn ${dockOpen ? 'on' : ''}`} onClick={toggleDock}>
        <Icon name="layers" size={18} /><span>Activity</span>
        <AnimatePresence>{active > 0 && <motion.b className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>{active}</motion.b>}</AnimatePresence>
      </button>
      <nav>{NAV2.map(item)}</nav>
    </aside>
  );
}

export function JobRow({ job, onRetry }) {
  const m = job.meta || {};
  const running = job.status === 'running';
  const tone = job.status === 'error' ? 'bad' : job.status === 'done' ? 'good' : '';
  const out = job.outputs && job.outputs[0];
  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }} transition={spring} className={`job ${job.status}`}>
      <div className="job-top">
        <div className="job-name" title={m.name}>{m.name || 'File'}</div>
        <div className="job-actions">
          {(job.status === 'queued' || running) && <IconButton icon="x" title="Cancel" onClick={() => api.cancel(job.id)} size={15} />}
          {(job.status === 'error' || job.status === 'cancelled') && onRetry && <IconButton icon="refresh" title="Try again" onClick={() => onRetry(job)} size={15} />}
          {job.status === 'done' && out && <IconButton icon="folder" title="Show in folder" onClick={() => api.show(out)} size={15} />}
        </div>
      </div>
      {job.status === 'done' ? (
        <div className="job-sub good"><span><Icon name="check" size={14} /> {m.to ? `Converted to ${String(m.to).toUpperCase()}` : 'Done'}{m.srcSize && job.sizeOut ? ` · ${fmtBytes(m.srcSize)} → ${fmtBytes(job.sizeOut)}` : ''}</span>{job.elapsed ? <span>{fmtDuration(job.elapsed)}</span> : null}</div>
      ) : job.status === 'error' ? (
        <div className="job-sub bad">{job.error}</div>
      ) : job.status === 'cancelled' ? (
        <div className="job-sub">Cancelled</div>
      ) : (
        <>
          <Progress value={job.progress} tone={tone} />
          <div className="job-sub"><span>{job.label}</span><span>{Math.round((job.progress || 0) * 100)}%</span></div>
        </>
      )}
      {job.note && <div className="job-sub warn">{job.note}</div>}
    </motion.div>
  );
}

export function Dock() {
  const { jobs, dockOpen, dockMode, setDockOpen, run, route, toast, clearFinishedJobs } = useApp();
  const [clearing, setClearing] = useState(false);
  const list = Object.values(jobs).sort((a, b) => ((b.meta && b.meta.t) || 0) - ((a.meta && a.meta.t) || 0));
  const finished = list.filter((j) => !['queued', 'running'].includes(j.status)).length;
  const busy = list.some((j) => j.status === 'running' || j.status === 'queued');
  React.useEffect(() => {
    if (dockMode !== 'auto' || busy || !list.length) return undefined;
    const t = setTimeout(() => setDockOpen(false), 7000);
    return () => clearTimeout(t);
  }, [dockMode, busy, list.length, setDockOpen]);
  React.useEffect(() => { if (dockMode === 'auto' && !busy) setDockOpen(false); }, [route]); // eslint-disable-line
  const retry = async (j) => {
    if (!j.spec) return;
    try { await run([j.spec], [{ ...j.meta, t: Date.now() }]); }
    catch (e) { toast(errorText(e, 'That job could not be started again.'), 'error'); }
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try { await clearFinishedJobs(); }
    catch (e) { toast(errorText(e, 'Finished activity could not be cleared.'), 'error'); }
    finally { setClearing(false); }
  };
  return (
    <AnimatePresence>
      {dockOpen && (
        <motion.div className="dock glass" initial={{ opacity: 0, x: 40, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }} transition={spring}>
          <div className="dock-head">
            <b>Activity</b>
            <div className="dock-btns">
              {list.some((j) => j.status === 'running' || j.status === 'queued') && <Button size="sm" variant="ghost" onClick={() => api.cancelAll()}>Cancel all</Button>}
              {finished > 0 && <Button size="sm" variant="ghost" onClick={clear} disabled={clearing}>{clearing ? 'Clearing…' : 'Clear'}</Button>}
              <IconButton icon="x" title="Close" onClick={() => setDockOpen(false)} size={15} />
            </div>
          </div>
          <div className="dock-list">
            <AnimatePresence initial={false}>{list.map((j) => <JobRow key={j.id} job={j} onRetry={retry} />)}</AnimatePresence>
            {!list.length && <div className="dock-empty">Nothing running yet. Drop a file anywhere to begin.</div>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} className={`toast glass ${t.tone}`} initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.96 }} transition={spring}>
            <Icon name={t.tone === 'error' ? 'info' : 'check'} size={16} /> {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function DropOverlay() {
  const { dragging } = useApp();
  return (
    <AnimatePresence>
      {dragging && (
        <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="drop-ring" initial={{ scale: 0.9 }} animate={{ scale: [1, 1.03, 1] }} transition={{ repeat: Infinity, duration: 1.6 }}>
            <Icon name="upload" size={42} />
            <b>Release to add your files</b>
            <span>Photos, videos, audio, PDFs and documents</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
