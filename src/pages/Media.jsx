import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Reorder } from 'framer-motion';
import { api, fmtBytes, fmtTime, parseSize, extLabel, errorText } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Icon, Button, IconButton, Chip, Segmented, Slider, PageHeader, Card, motion } from '../ui.jsx';
import { DropZone, FILTERS, FileThumb, SizeTarget, QUICK_SIZES } from '../pagekit.jsx';

const VIDEO_OUT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv'];
const AUDIO_OUT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'];

function Timeline({ info, isVideo, start, end, onRange, time, onSeek, file }) {
  const ref = useRef(null);
  const [frames, setFrames] = useState([]);
  const dur = info.duration || 1;
  useEffect(() => {
    let alive = true;
    setFrames([]);
    if (!isVideo) return;
    const n = 12;
    api.mediaFrames(file.path, Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n), 72).then((f) => alive && setFrames(f)).catch(() => {});
    return () => { alive = false; };
  }, [file.path, dur, isVideo]);

  const toT = (clientX) => { const r = ref.current.getBoundingClientRect(); return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur)); };
  const drag = (which) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const mv = (ev) => {
      const t = toT(ev.clientX);
      if (which === 'a') { const v = Math.min(t, end - 0.2); onRange(Math.max(0, v), end); onSeek(Math.max(0, v)); }
      else if (which === 'b') { const v = Math.max(t, start + 0.2); onRange(start, Math.min(dur, v)); onSeek(Math.min(dur, v)); }
      else onSeek(t);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    if (which === 'seek') mv(e);
  };
  const pct = (t) => (t / dur) * 100 + '%';
  return (
    <div className="timeline" ref={ref} onPointerDown={drag('seek')}>
      <div className="tl-frames">{isVideo ? Array.from({ length: 12 }, (_, i) => <div key={i} style={frames[i] ? { backgroundImage: `url(${frames[i]})` } : undefined} />) : <Wave />}</div>
      <div className="tl-dim" style={{ left: 0, width: pct(start) }} />
      <div className="tl-dim" style={{ right: 0, width: `calc(100% - ${pct(end)})` }} />
      <div className="tl-range" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
      <div className="tl-handle a" style={{ left: pct(start) }} onPointerDown={drag('a')}><i /></div>
      <div className="tl-handle b" style={{ left: pct(end) }} onPointerDown={drag('b')}><i /></div>
      <div className="tl-play" style={{ left: pct(time) }} />
    </div>
  );
}
function Wave() {
  const bars = React.useMemo(() => Array.from({ length: 90 }, (_, i) => 18 + Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11)) * 70 + ((i * 53) % 13)), []);
  return <div className="wave">{bars.map((h, i) => <span key={i} style={{ height: h + '%' }} />)}</div>;
}

function Editor({ file, onClose }) {
  const { run, toast, setDockOpen } = useApp();
  const [info, setInfo] = useState(null);
  const [url, setUrl] = useState('');
  const [range, setRange] = useState([0, 0]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [to, setTo] = useState(file.category === 'video' ? 'mp4' : 'mp3');
  const [res, setRes] = useState('source');
  const [vol, setVol] = useState(100);
  const [target, setTarget] = useState(false);
  const [tv, setTv] = useState('10');
  const [tu, setTu] = useState('MB');
  const [loadError, setLoadError] = useState('');
  const mediaRef = useRef(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.mediaInfo(file.path), api.mediaUrl(file.path)]).then(([i, u]) => {
      if (!alive) return;
      setInfo(i); setUrl(u); setRange([0, i.duration]);
    }).catch((e) => {
      if (!alive) return;
      const message = errorText(e, 'Could not read this file.');
      setLoadError(message);
      toast(message, 'error');
    });
    return () => { alive = false; };
  }, [file.path, toast]);

  const isVideo = !!(info && info.hasVideo);
  const el = () => mediaRef.current;
  const seek = (t) => { setTime(t); if (el()) el().currentTime = t; };
  const toggle = () => { const m = el(); if (!m) return; if (m.paused) { if (m.currentTime < range[0] || m.currentTime >= range[1] - 0.05) m.currentTime = range[0]; const p = m.play(); if (p && p.catch) p.catch(() => {}); } else m.pause(); };
  useEffect(() => { const m = el(); if (m) m.volume = Math.min(1, vol / 100); }, [vol, url]);
  const onTick = () => { const m = el(); if (!m) return; setTime(m.currentTime); if (m.currentTime >= range[1]) { m.pause(); m.currentTime = range[0]; } };

  const build = (kind, over = {}) => {
    const trim = { start: range[0] > 0.05 ? range[0] : 0, end: info && range[1] < info.duration - 0.05 ? range[1] : 0 };
    const opts = { trim, volume: vol, targetBytes: target ? parseSize(tv, tu.toLowerCase()) : 0, height: res === 'source' ? 0 : Number(res), ...over.opts };
    return { kind: kind || 'convert', file: file.path, to: over.to || to, opts };
  };
  const go = async (spec, label) => {
    try {
      await run([spec], [{ name: file.name, to: spec.to, srcSize: file.size, t: Date.now() }]);
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'That conversion could not be started.'), 'error'); }
  };
  const targets = isVideo ? [...VIDEO_OUT, 'gif', ...AUDIO_OUT.slice(0, 4)] : AUDIO_OUT;
  const trimmed = info && (range[0] > 0.05 || range[1] < info.duration - 0.05);

  if (!info) return (
    <div className="page">
      <PageHeader title="Video & Audio" sub={file.name} right={<Button variant="ghost" icon="plus" onClick={onClose}>Open another</Button>} />
      <Card>
        {loadError ? (
          <div className="row"><div className="grow"><b>This file could not be opened</b><div className="muted small">{loadError}</div></div><Button variant="soft" icon="plus" onClick={onClose}>Choose another</Button></div>
        ) : <div className="muted">Reading file…</div>}
      </Card>
    </div>
  );
  return (
    <div className="page studio media">
      <PageHeader title="Video & Audio" sub={`${file.name} · ${fmtTime(info.duration)}${isVideo ? ` · ${info.width}×${info.height}` : ''} · ${fmtBytes(file.size)}`} right={<Button variant="ghost" icon="plus" onClick={onClose}>Open another</Button>} />
      <div className="media-grid">
        <div className="media-main">
          <div className="player glass">
            {isVideo ? <video ref={mediaRef} src={url || undefined} onTimeUpdate={onTick} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={toggle} />
              : <><audio ref={mediaRef} src={url || undefined} onTimeUpdate={onTick} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} /><div className="audio-art"><motion.div animate={playing ? { scale: [1, 1.08, 1] } : {}} transition={{ repeat: Infinity, duration: 1.2 }}><Icon name="music" size={54} /></motion.div></div></>}
            <div className="player-bar">
              <IconButton icon={playing ? 'pause' : 'play'} title={playing ? 'Pause' : 'Play'} onClick={toggle} />
              <span className="mono">{fmtTime(time)} / {fmtTime(info.duration)}</span>
            </div>
          </div>
          <Card className="tl-card">
            <Timeline info={info} isVideo={isVideo} start={range[0]} end={range[1]} onRange={(a, b) => setRange([a, b])} time={time} onSeek={seek} file={file} />
            <div className="tl-info">
              <span>Start <b className="mono">{fmtTime(range[0])}</b></span>
              <span className="muted">{trimmed ? `Keeping ${fmtTime(range[1] - range[0])}` : 'Drag the handles to trim'}</span>
              <span>End <b className="mono">{fmtTime(range[1])}</b></span>
            </div>
            {trimmed && <div className="tl-reset"><Button size="sm" variant="ghost" onClick={() => { setRange([0, info.duration]); }}>Reset trim</Button></div>}
          </Card>
        </div>
        <div className="studio-panel glass media-panel">
          <div className="panel-body">
            <div className="lbl">Save as</div>
            <div className="chips">{targets.map((t) => <Chip key={t} small active={to === t} onClick={() => setTo(t)}>{extLabel(t)}</Chip>)}</div>
            {isVideo && !AUDIO_OUT.includes(to) && to !== 'gif' && (<><div className="lbl">Resolution</div>
              <Segmented small value={res} onChange={setRes} options={[{ value: 'source', label: 'Original' }, { value: '1080', label: '1080p' }, { value: '720', label: '720p' }, { value: '480', label: '480p' }]} /></>)}
            <Slider label="Volume" value={vol} min={0} max={200} step={5} onChange={setVol} format={(v) => v + '%'} />
            {to !== 'gif' && !['wav', 'flac'].includes(to) && <>
              <SizeTarget enabled={target} onEnable={setTarget} value={tv} onValue={setTv} unit={tu} onUnit={setTu} label="Limit file size" />
              <div className="chips">{QUICK_SIZES.filter((q) => q.u === 'MB' || q.v === '500').map((q) => <Chip key={q.label} small onClick={() => { setTarget(true); setTv(q.v); setTu(q.u); }}>{q.label}</Chip>)}</div></>}
            <div className="quick">
              <div className="lbl">Quick actions</div>
              {isVideo && <Button icon="music" variant="soft" onClick={() => go(build('extract-audio', { to: 'mp3' }))}>Extract audio (MP3)</Button>}
              {isVideo && <Button icon="spark" variant="soft" onClick={() => go(build('convert', { to: 'gif', opts: { gifFps: 12, gifWidth: 480 } }))}>Make a GIF</Button>}
            </div>
          </div>
          <div className="panel-foot"><Button variant="primary" icon="download" onClick={() => go(build('convert'))}>{trimmed ? 'Trim & save' : 'Save'}</Button></div>
        </div>
      </div>
    </div>
  );
}

function Merge() {
  const { run, toast, setDockOpen } = useApp();
  const [items, setItems] = useState([]);
  const [to, setTo] = useState('mp4');
  let id = useRef(0);
  const add = useCallback(async (paths) => {
    try {
      const d = (await api.describe(paths)).filter((x) => x.category === 'video' || x.category === 'audio');
      if (!d.length) { toast('Choose video or audio files', 'error'); return; }
      setItems((cur) => [...cur, ...d.filter((x) => !cur.some((c) => c.path === x.path)).map((x) => ({ ...x, id: ++id.current }))]);
    } catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  }, [toast]);
  useDrop(add);
  const audioOnly = items.length > 0 && items.every((i) => i.category === 'audio');
  useEffect(() => { setTo(audioOnly ? 'mp3' : 'mp4'); }, [audioOnly]);
  const pick = async () => {
    try { const p = await api.pick({ filters: FILTERS.media }); if (p.length) await add(p); }
    catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  };
  const go = async () => {
    if (items.length < 2) { toast('Add at least two clips', 'error'); return; }
    try {
      await run([{ kind: 'merge-media', files: items.map((i) => i.path), to }], [{ name: `${items.length} clips`, to, srcSize: items.reduce((a, i) => a + i.size, 0), t: Date.now() }]);
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'The merge could not be started.'), 'error'); }
  };
  return (
    <>
      <PageHeader title="Merge clips" sub="Join videos or audio files end to end. Drag to set the order." />
      {!items.length ? <DropZone onPick={pick} title="Drop two or more clips" icon="merge" /> : (
        <>
          <Reorder.Group axis="y" values={items} onReorder={setItems} className="flist reorder">
            {items.map((f, i) => (
              <Reorder.Item key={f.id} value={f} className="frow glass grab" whileDrag={{ scale: 1.02, boxShadow: '0 14px 40px rgba(0,0,0,.35)' }}>
                <span className="order">{i + 1}</span><FileThumb file={f} />
                <div className="frow-main"><div className="frow-name">{f.name}</div><div className="frow-meta"><span className="tag">{extLabel(f.ext)}</span><span className="muted">{fmtBytes(f.size)}</span></div></div>
                <IconButton icon="trash" title="Remove" onClick={() => setItems((c) => c.filter((x) => x.id !== f.id))} size={16} />
              </Reorder.Item>
            ))}
          </Reorder.Group>
          <div className="actionbar glass">
            <Button icon="plus" onClick={pick}>Add more</Button>
            <div className="chips">{(audioOnly ? ['mp3', 'wav', 'flac', 'm4a', 'ogg'] : ['mp4', 'mkv', 'webm', 'mov']).map((t) => <Chip key={t} small active={to === t} onClick={() => setTo(t)}>{extLabel(t)}</Chip>)}</div>
            <div className="grow" />
            <Button variant="primary" icon="merge" onClick={go}>Merge {items.length} clips</Button>
          </div>
        </>
      )}
    </>
  );
}

export default function Media() {
  const [mode, setMode] = useState('edit');
  const [file, setFile] = useState(null);
  const { toast } = useApp();
  const open = useCallback(async (paths) => {
    try {
      const d = (await api.describe(paths)).filter((x) => x.category === 'video' || x.category === 'audio');
      if (!d.length) { toast('Choose a video or audio file', 'error'); return; }
      setFile(d[0]);
    } catch (e) { toast(errorText(e, 'That file could not be read.'), 'error'); }
  }, [toast]);
  useDrop(mode === 'edit' ? open : null);
  const pick = async () => {
    try { const p = await api.pick({ filters: FILTERS.media }); if (p.length) await open(p); }
    catch (e) { toast(errorText(e, 'That file could not be read.'), 'error'); }
  };
  if (mode === 'edit' && file) return <Editor key={file.path} file={file} onClose={() => setFile(null)} />;
  return (
    <div className="page">
      <div className="modebar"><Segmented value={mode} onChange={setMode} options={[{ value: 'edit', label: 'Trim & convert' }, { value: 'merge', label: 'Merge clips' }]} /></div>
      {mode === 'edit' ? (<>
        <PageHeader title="Video & Audio" sub="Trim with a timeline, change resolution, extract audio, make GIFs and more." />
        <DropZone onPick={pick} title="Drop a video or audio file" icon="film" hint="MP4 · MKV · MOV · AVI · WEBM · MP3 · WAV · FLAC · AAC · OGG" />
      </>) : <Merge />}
    </div>
  );
}
