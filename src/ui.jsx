import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const P = {
  convert: 'M4 8h13l-3-3M20 16H7l3 3',
  compress: 'M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  folder: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 17v3h16v-3',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  rotate: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  flipH: 'M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z',
  flipV: 'M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z',
  crop: 'M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14',
  scissors: 'M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM8.1 7.9L20 20M8.1 16.1L20 4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 017.5-2',
  drop: 'M12 3s6 6.5 6 11a6 6 0 11-12 0c0-4.5 6-11 6-11z',
  merge: 'M5 4v4a4 4 0 004 4h6a4 4 0 014 4v4M19 4v4a4 4 0 01-1.2 2.8M12 12v8',
  split: 'M12 3v8M12 11l-6 6v4M12 11l6 6v4M9 6l3-3 3 3',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  minus: 'M5 12h14',
  square: 'M5 5h14v14H5z',
  restore: 'M8 8h11v11H8zM5 15V5h10',
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v6h-6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z',
  scan: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  bell: 'M6 8a6 6 0 1112 0c0 7 3 8 3 8H3s3-1 3-8zM10 20a2 2 0 004 0',
  eraser: 'M4 16l9-9 6 6-6 6H8zM9 21h12',
  wand: 'M4 20L16 8M14 4l1.5 3L19 8.5 15.5 10 14 13l-1.5-3L9 8.5 12.5 7zM19 14l.7 1.6 1.6.7-1.6.7L19 18.6l-.7-1.6-1.6-.7 1.6-.7z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  eyeoff: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.9M6.4 6.7A17 17 0 002 12s4 6 10 6a9.7 9.7 0 004.1-.9M9.9 9.9a3 3 0 004.2 4.2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
};

export function Icon({ name, size = 18, stroke = 1.8, className = '', style }) {
  return (
    <svg className={`ico ${className}`} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || P.file} />
    </svg>
  );
}

export function Logo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-label="MorphEra">
      <defs>
        <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#6366f1" /><stop offset="1" stopColor="#d946ef" /></linearGradient>
        <linearGradient id="lg0" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1b1f4b" /><stop offset="1" stopColor="#0b0d1a" /></linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#lg0)" />
      <path d="M120 372V176c0-26 32-36 48-16l68 90c11 14 29 14 40 0l68-90c16-20 48-10 48 16v196" fill="none" stroke="url(#lg1)" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="392" cy="372" r="14" fill="#fff" fillOpacity=".9" />
    </svg>
  );
}

export const spring = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 };

export function Button({ children, variant = 'soft', icon, onClick, disabled, size = 'md', title, className = '', type = 'button' }) {
  return (
    <motion.button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={spring}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children != null && <span>{children}</span>}
    </motion.button>
  );
}

export function IconButton({ icon, onClick, title, active, disabled, size = 17, className = '' }) {
  return (
    <motion.button className={`ibtn ${active ? 'on' : ''} ${className}`} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }} transition={spring} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={size} />
    </motion.button>
  );
}

export function Chip({ children, active, onClick, tone, small, title }) {
  return (
    <motion.button
      type="button" title={title}
      className={`chip ${active ? 'on' : ''} ${tone || ''} ${small ? 'sm' : ''}`}
      whileHover={{ y: -1 }} whileTap={{ scale: 0.95 }} transition={spring} onClick={onClick}
    >
      {children}
    </motion.button>
  );
}

export function Segmented({ options, value, onChange, small }) {
  const id = useRef('seg' + Math.random().toString(36).slice(2)).current;
  return (
    <div className={`seg ${small ? 'sm' : ''}`} role="tablist">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        const on = v === value;
        return (
          <button key={v} role="tab" aria-selected={on} className={on ? 'on' : ''} onClick={() => onChange(v)} type="button">
            {on && <motion.span layoutId={id} className="seg-pill" transition={spring} />}
            <span className="seg-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  const toggle = () => { if (!disabled) onChange(!checked); };
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`} onClick={(e) => { if (!e.target.closest('.switch')) toggle(); }}>
      <span className="toggle-text"><span className="toggle-label">{label}</span>{hint && <span className="hint">{hint}</span>}</span>
      <span className={`switch ${checked ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); toggle(); }} role="switch" aria-checked={checked} aria-disabled={!!disabled} tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => { if (!disabled && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(); } }}>
        <motion.span className="knob" layout transition={spring} />
      </span>
    </label>
  );
}

export function Slider({ value, min = 0, max = 100, step = 1, onChange, label, format, disabled }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={`slider ${disabled ? 'disabled' : ''}`}>
      {label && <div className="slider-head"><span>{label}</span><b>{format ? format(value) : value}</b></div>}
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ '--p': pct + '%' }} />
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label className="field-label">{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Select({ value, onChange, options, small }) {
  return (
    <div className={`select ${small ? 'sm' : ''}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
      <Icon name="chevronDown" size={15} />
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, type = 'text', suffix, onEnter, width }) {
  return (
    <div className="input" style={width ? { width } : undefined}>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }} spellCheck={false} />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

export function Card({ children, className = '', pad = true, style, ...rest }) {
  return <div className={`glass card ${pad ? 'pad' : ''} ${className}`} style={style} {...rest}>{children}</div>;
}

export function Section({ title, hint, right, children }) {
  return (
    <div className="section">
      <div className="section-head">
        <div><h3>{title}</h3>{hint && <p className="hint">{hint}</p>}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export function PageHeader({ title, sub, right }) {
  return (
    <div className="page-head">
      <div>
        <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>{title}</motion.h1>
        {sub && <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }}>{sub}</motion.p>}
      </div>
      {right}
    </div>
  );
}

export function Progress({ value, tone }) {
  return (
    <div className={`bar ${tone || ''}`}>
      <motion.div className="bar-fill" initial={false} animate={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} transition={{ type: 'spring', stiffness: 160, damping: 26 }} />
      <div className="bar-shine" />
    </div>
  );
}

export function Empty({ icon = 'file', title, text }) {
  return (
    <div className="empty">
      <motion.div className="empty-ico" animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 4, ease: 'easeInOut' }}><Icon name={icon} size={26} /></motion.div>
      <b>{title}</b>
      {text && <span>{text}</span>}
    </div>
  );
}

export function useLocalState(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s != null ? JSON.parse(s) : initial; } catch { return initial; } });
  const set = useCallback((x) => { setV((p) => { const n = typeof x === 'function' ? x(p) : x; try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* ignore */ } return n; }); }, [key]);
  return [v, set];
}

export { motion, AnimatePresence };
