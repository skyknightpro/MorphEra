import React, { useState } from 'react';
import { api, fmtBytes } from './api.js';
import { Icon, motion, spring } from './ui.jsx';

export const CAT_ICON = { image: 'image', video: 'film', audio: 'music', document: 'file' };

export function DropZone({ onPick, title = 'Drop files here', sub = 'or', pickLabel = 'Choose files', compact, icon = 'upload', hint }) {
  const [over, setOver] = useState(false);
  return (
    <motion.div
      className={`dropzone ${compact ? 'compact' : ''} ${over ? 'over' : ''}`}
      onDragEnter={() => setOver(true)} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}
      whileHover={{ scale: 1.005 }} transition={spring}
      onClick={onPick} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
    >
      <div className="dz-glow" />
      <motion.div className="dz-icon" animate={over ? { y: -6, scale: 1.12 } : { y: [0, -4, 0] }} transition={over ? spring : { repeat: Infinity, duration: 3.6, ease: 'easeInOut' }}>
        <Icon name={icon} size={compact ? 22 : 30} />
      </motion.div>
      <div className="dz-title">{over ? 'Release to add' : title}</div>
      <div className="dz-sub">{sub} <u>{pickLabel}</u>{!compact && <> · or paste with <kbd>Ctrl</kbd>+<kbd>V</kbd></>}</div>
      {hint && !compact && <div className="dz-hint">{hint}</div>}
    </motion.div>
  );
}

export async function pickAndDescribe(filters) {
  const paths = await api.pick(filters ? { filters } : {});
  return paths.length ? api.describe(paths) : [];
}

export const FILTERS = {
  image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'ico', 'heic', 'heif', 'avif', 'svg'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'] }],
  media: [{ name: 'Video & audio', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  compress: [{ name: 'Images, video, audio, PDF', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tiff', 'tif', 'bmp', 'heic', 'gif', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'pdf'] }],
};

export function FileThumb({ file, size = 44 }) {
  const [src, setSrc] = useState('');
  React.useEffect(() => {
    let alive = true;
    if (file.category === 'image') api.imagePreview(file.path, 160).then((p) => alive && setSrc(p.dataUrl)).catch(() => {});
    return () => { alive = false; };
  }, [file.path, file.category]);
  return (
    <div className={`thumb ${file.category || 'unknown'}`} style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" /> : <Icon name={CAT_ICON[file.category] || 'file'} size={size * 0.46} />}
    </div>
  );
}

export function Sizes({ before, after }) {
  if (!after) return <span className="muted">{fmtBytes(before)}</span>;
  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  return (
    <span className="sizes">
      <span className="muted">{fmtBytes(before)}</span> <Icon name="chevron" size={12} /> <b>{fmtBytes(after)}</b>
      {before > 0 && <em className={pct >= 0 ? 'good' : 'bad'}>{pct >= 0 ? `−${pct}%` : `+${-pct}%`}</em>}
    </span>
  );
}

export function SizeTarget({ enabled, onEnable, value, onValue, unit, onUnit, label = 'Limit file size', fixed }) {
  return (
    <div className="size-target">
      {fixed ? (
        <div className="toggle-inline fixed"><span className="check on"><Icon name="check" size={13} stroke={3} /></span><span>{label}</span></div>
      ) : (
        <label className="toggle-inline"><span className={`check ${enabled ? 'on' : ''}`} onClick={() => onEnable(!enabled)}>{enabled && <Icon name="check" size={13} stroke={3} />}</span><span onClick={() => onEnable(!enabled)}>{label}</span></label>
      )}
      <motion.div className="size-inputs" animate={{ opacity: enabled ? 1 : 0.4 }}>
        <div className="input"><input value={value} disabled={!enabled} onChange={(e) => onValue(e.target.value)} inputMode="decimal" placeholder="200" /></div>
        <div className="seg sm">
          {['KB', 'MB'].map((u) => <button key={u} className={unit === u ? 'on' : ''} disabled={!enabled} onClick={() => onUnit(u)} type="button">{unit === u && <motion.span layoutId="sz-unit" className="seg-pill" transition={spring} />}<span className="seg-label">{u}</span></button>)}
        </div>
      </motion.div>
    </div>
  );
}

export const QUICK_SIZES = [
  { label: '100 KB', v: '100', u: 'KB' }, { label: '200 KB', v: '200', u: 'KB' }, { label: '500 KB', v: '500', u: 'KB' },
  { label: '1 MB', v: '1', u: 'MB' }, { label: '2 MB', v: '2', u: 'MB' }, { label: '10 MB', v: '10', u: 'MB' },
];

export function Compare({ before, after, labelA = 'Original', labelB = 'Result' }) {
  const [x, setX] = useState(50);
  const ref = React.useRef(null);
  const move = (clientX) => { const r = ref.current.getBoundingClientRect(); setX(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100))); };
  const down = (e) => {
    move(e.clientX);
    const mv = (ev) => move(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div className="compare" ref={ref} onPointerDown={down}>
      <img src={after} alt="" draggable={false} />
      <div className="compare-before" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }}><img src={before} alt="" draggable={false} /></div>
      <div className="compare-line" style={{ left: x + '%' }}><span><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /><Icon name="chevron" size={14} /></span></div>
      <span className="compare-tag l">{labelA}</span><span className="compare-tag r">{labelB}</span>
    </div>
  );
}
