import React from 'react';
import { api, errorText } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon, Button, IconButton, PageHeader, Empty, motion, AnimatePresence, spring } from '../ui.jsx';
import { Sizes } from '../pagekit.jsx';

const KIND = { convert: 'Converted', compress: 'Compressed', 'edit-image': 'Edited', 'merge-pdf': 'Merged PDFs', 'split-pdf': 'Split PDF', 'arrange-pdf': 'Reorganized PDF', 'watermark-pdf': 'Watermarked', 'lock-pdf': 'Locked PDF', 'unlock-pdf': 'Unlocked PDF', 'pdf-to-images': 'PDF to images', 'images-to-pdf': 'Images to PDF', 'merge-media': 'Merged clips', 'extract-audio': 'Extracted audio', watch: 'Watch folder' };

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function History() {
  const { history, loadHistory, toast } = useApp();
  const clear = async () => {
    try { await api.clearHistory(); await loadHistory(); }
    catch (e) { toast(errorText(e, 'The history could not be cleared.'), 'error'); }
  };
  return (
    <div className="page">
      <PageHeader title="History" sub="Everything you converted. Open it again with one click." right={history.length > 0 && <Button variant="ghost" icon="trash" onClick={clear}>Clear history</Button>} />
      {!history.length ? <Empty icon="clock" title="Nothing here yet" text="Your finished conversions will show up in this list." /> : (
        <div className="flist">
          <AnimatePresence initial={false}>
            {history.slice(0, 100).map((h, i) => {
              const output = h.outputs && h.outputs[0];
              return (
                <motion.div key={h.id + h.time} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(i, 8) * 0.025 }} className="frow glass hist">
                  <div className="thumb document"><Icon name={h.kind === 'compress' ? 'compress' : 'convert'} size={20} /></div>
                  <div className="frow-main">
                    <div className="frow-name">{h.name || h.source}</div>
                    <div className="frow-meta"><span className="tag">{KIND[h.kind] || 'Done'}{h.to ? ` · ${String(h.to).toUpperCase()}` : ''}</span><span className="muted">from {h.source}</span>{h.sizeIn > 0 && <Sizes before={h.sizeIn} after={h.sizeOut} />}</div>
                  </div>
                  <span className="muted small">{ago(h.time)}</span>
                  <div className="frow-end wide">
                    <IconButton icon="external" title="Open" onClick={() => api.open(h.folder || output)} disabled={!h.folder && !output} size={16} />
                    <IconButton icon="folder" title="Show in folder" onClick={() => api.show(output)} disabled={!output} size={16} />
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
