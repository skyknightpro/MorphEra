import React, { useState, useCallback } from 'react';
import { api, errorText } from '../api.js';
import { useApp, useDrop } from '../store.jsx';
import { Icon, PageHeader, Button, motion, spring } from '../ui.jsx';
import { pickAndDescribe } from '../pagekit.jsx';

const META = {
  whatsapp: { icon: 'bell', color: 'linear-gradient(135deg,#22c55e,#16a34a)', does: ['Photos shrunk to 1600 px, under 500 KB', 'Video to 720p, kept under 15 MB', 'Audio as 128 kbps MP3'] },
  email: { icon: 'download', color: 'linear-gradient(135deg,#38bdf8,#6366f1)', does: ['Photos shrunk to 1280 px, under 300 KB', 'Video to 720p, under 20 MB', 'PDFs compressed under 5 MB'] },
  youtube: { icon: 'play', color: 'linear-gradient(135deg,#f43f5e,#f97316)', does: ['Video as 1080p H.264 MP4, high quality', 'Thumbnails at 1280 × 720', 'Audio as 320 kbps MP3'] },
  print: { icon: 'image', color: 'linear-gradient(135deg,#a78bfa,#d946ef)', does: ['Lossless PNG at 300 DPI', 'Keeps full resolution', 'Best for printing photos and posters'] },
};

export default function Presets() {
  const { info, run, toast, setDockOpen } = useApp();
  const [sel, setSel] = useState('whatsapp');

  const go = useCallback(async (paths, id = sel) => {
    try {
      const d = (await api.describe(paths)).filter((x) => x.supported);
      if (!d.length) { toast('No supported files', 'error'); return; }
      const specs = d.map((f) => ({ kind: 'convert', file: f.path, to: '', preset: id, opts: {}, edits: {} }));
      await run(specs, d.map((f) => ({ name: f.name, to: '', srcSize: f.size, t: Date.now() })));
      setDockOpen(true);
    } catch (e) { toast(errorText(e, 'That preset could not be started.'), 'error'); }
  }, [sel, run, toast, setDockOpen]);
  useDrop(go);
  const pick = async (id = sel) => {
    try { const d = await pickAndDescribe(); if (d.length) await go(d.map((x) => x.path), id); }
    catch (e) { toast(errorText(e, 'Those files could not be read.'), 'error'); }
  };

  return (
    <div className="page">
      <PageHeader title="Presets" sub="One click, perfect for where it is going. Drop files anywhere in the window to use the selected preset." />
      <div className="preset-grid">
        {info && info.presets.map((p, i) => {
          const m = META[p.id] || META.email;
          const on = sel === p.id;
          return (
            <motion.div key={p.id} className={`preset glass ${on ? 'on' : ''}`} onClick={() => setSel(p.id)} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.05 }} whileHover={{ y: -4 }}>
              <div className="preset-ico" style={{ background: m.color }}><Icon name={m.icon} size={22} /></div>
              <h3>{p.label}</h3>
              <ul>{m.does.map((d) => <li key={d}><Icon name="check" size={13} stroke={2.6} /> {d}</li>)}</ul>
              <Button variant={on ? 'primary' : 'soft'} icon="upload" onClick={(e) => { e.stopPropagation(); setSel(p.id); pick(p.id); }}>Choose files</Button>
            </motion.div>
          );
        })}
      </div>
      <p className="hint center">Selected: <b>{info && info.presets.find((p) => p.id === sel)?.label}</b>. Drag files anywhere in the window to use it.</p>
    </div>
  );
}
