import React from 'react';
import { api, errorText } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon, Button, PageHeader, Card, Select, Toggle, Chip, motion } from '../ui.jsx';

const RULES = [
  { cat: 'image', label: 'Images', icon: 'image', opts: ['skip', 'jpg', 'png', 'webp', 'avif', 'pdf'] },
  { cat: 'video', label: 'Video', icon: 'film', opts: ['skip', 'mp4', 'mkv', 'webm', 'gif', 'mp3'] },
  { cat: 'audio', label: 'Audio', icon: 'music', opts: ['skip', 'mp3', 'wav', 'flac', 'm4a', 'ogg'] },
  { cat: 'document', label: 'Documents', icon: 'file', opts: ['skip', 'pdf', 'docx', 'txt', 'html', 'xlsx', 'csv'] },
];

export default function Watch() {
  const { info, setSettings, toast } = useApp();
  if (!info) return null;
  const w = info.settings.watch;
  const patch = (p) => setSettings({ watch: p }).catch((e) => toast(errorText(e, 'That setting could not be saved.'), 'error'));
  const choose = async () => {
    try {
      const f = await api.pickFolder();
      if (!f) return null;
      await patch({ folder: f });
      return f;
    } catch (e) { toast(errorText(e, 'That folder could not be used.'), 'error'); return null; }
  };
  return (
    <div className="page">
      <PageHeader title="Watch Folder" sub="Point MorphEra at a folder. Anything you drop in is converted automatically." />
      <Card className="watch-card">
        <div className="watch-top">
          <motion.div className={`pulse ${w.enabled && w.folder ? 'live' : ''}`} animate={w.enabled && w.folder ? { scale: [1, 1.12, 1] } : {}} transition={{ repeat: Infinity, duration: 2.2 }}><Icon name="eye" size={22} /></motion.div>
          <div className="grow">
            <div className="opt-title">Folder to watch</div>
            <div className="path-box">{w.folder || 'No folder chosen yet'}</div>
          </div>
          <Button icon="folder" onClick={choose}>{w.folder ? 'Change' : 'Choose folder'}</Button>
        </div>
        <Toggle checked={!!w.enabled} onChange={(v) => {
          if (v && !w.folder) { choose().then((f) => { if (f) patch({ enabled: true }); }); }
          else patch({ enabled: v });
        }} label="Watching is on" hint="Converted files go to a “MorphEra Converted” folder inside the watched folder." />
      </Card>
      <Card className="watch-rules">
        <div className="opt-title">What to do with new files</div>
        <div className="rule-grid">
          {RULES.map((r) => (
            <div key={r.cat} className="rule">
              <div className="rule-head"><Icon name={r.icon} size={18} /><b>{r.label}</b></div>
              <Select value={(w.rules && w.rules[r.cat]) || 'skip'} onChange={(v) => patch({ rules: { ...w.rules, [r.cat]: v } })} options={r.opts.map((o) => ({ value: o, label: o === 'skip' ? 'Leave alone' : 'Convert to ' + o.toUpperCase() }))} />
            </div>
          ))}
        </div>
        <div className="opt-title" style={{ marginTop: 18 }}>Optimize with a preset</div>
        <div className="chips">
          <Chip active={!w.preset} onClick={() => patch({ preset: '' })}>None</Chip>
          {info.presets.map((p) => <Chip key={p.id} active={w.preset === p.id} onClick={() => patch({ preset: p.id })}>{p.label}</Chip>)}
        </div>
      </Card>
    </div>
  );
}
