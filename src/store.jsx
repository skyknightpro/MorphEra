import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, errorText } from './api.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function Provider({ children }) {
  const [info, setInfo] = useState(null);
  const [route, setRoute] = useState('convert');
  const [jobs, setJobs] = useState({});
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);
  const [office, setOffice] = useState(null);
  const [officeBusy, setOfficeBusy] = useState(false);
  const [officeInstall, setOfficeInstall] = useState(null);
  const [dockMode, setDockMode] = useState(false);
  const dockOpen = !!dockMode;
  const setDockOpen = useCallback((v) => setDockMode((m) => (v ? (m === 'manual' ? 'manual' : 'auto') : false)), []);
  const toggleDock = useCallback(() => setDockMode((m) => (m ? false : 'manual')), []);
  const metaRef = useRef({});
  const dropRef = useRef(null);
  const officeRef = useRef(null);
  const officeCheckRef = useRef(null);
  const officeInstallRef = useRef(null);

  const toast = useCallback((text, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6500 : 3800);
  }, []);

  const loadHistory = useCallback(async () => {
    try { setHistory(await api.history()); } catch { /* history is optional */ }
  }, []);

  const removeJobRows = useCallback((ids) => {
    if (!Array.isArray(ids) || !ids.length) return;
    const drop = new Set(ids);
    setJobs((current) => {
      const next = { ...current };
      for (const id of drop) delete next[id];
      return next;
    });
    for (const id of drop) delete metaRef.current[id];
  }, []);

  /** Remove completed activity rows from both the queue and the rendered list. */
  const clearFinishedJobs = useCallback(async () => {
    const ids = await api.clearFinished();
    removeJobRows(ids);
    return Array.isArray(ids) ? ids.length : 0;
  }, [removeJobRows]);

  const applyOffice = useCallback((status) => {
    if (!status) return null;
    officeRef.current = status;
    setOffice((current) => {
      // A fast availability check only proves the file is still there. Keep an
      // already verified status instead of flashing the setup gate.
      if (current && status.verified == null && current.verified != null && current.path === status.path) return current;
      return status;
    });
    setInfo((i) => (i ? { ...i, office: status, hasOffice: !!status.path } : i));
    return status;
  }, []);

  /** Re-run LibreOffice detection. Verifies by actually starting soffice. */
  const refreshOffice = useCallback(async () => {
    if (officeCheckRef.current) return officeCheckRef.current;
    setOfficeBusy(true);
    const promise = api.officeRecheck()
      .then((s) => applyOffice(s))
      .catch((e) => {
        const message = errorText(e, 'Could not check LibreOffice.');
        // Leave a failed check in a terminal state instead of a permanent
        // `verified: null` that would keep both the gate and Settings spinning.
        setOffice((o) => (o ? { ...o, healthy: false, verified: true, error: message, warning: null } : o));
        toast(message, 'error');
        return null;
      })
      .finally(() => { officeCheckRef.current = null; setOfficeBusy(false); });
    officeCheckRef.current = promise;
    return promise;
  }, [applyOffice, toast]);

  /** Let the user point at soffice manually. Returns the new status or null. */
  const locateOffice = useCallback(async () => {
    setOfficeBusy(true);
    try {
      const s = await api.officeLocate();
      if (s) applyOffice(s);
      return s;
    } catch (e) {
      toast(errorText(e, 'Could not use that program.'), 'error');
      return null;
    } finally {
      setOfficeBusy(false);
    }
  }, [applyOffice, toast]);

  /**
   * Download and install LibreOffice. On Windows the main process handles the
   * official mirror, signature verification and silent MSI installation; on
   * other platforms it opens the official download page. Progress arrives over
   * `office:install-progress`, so the gate can show a real progress bar.
   */
  const installOffice = useCallback(async () => {
    if (officeInstallRef.current) return officeInstallRef.current;
    const promise = (async () => {
      setOfficeInstall({ stage: 'preparing', percent: 1, message: 'Starting the LibreOffice installer…', busy: true, cancellable: true });
      try {
        const r = await api.officeInstall();
        if (r && r.manual) {
          setOfficeInstall(null);
          toast('Automatic installation is available on Windows. The official LibreOffice download page has been opened.', 'info');
          return r;
        }
        if (r && r.cancelled) {
          setOfficeInstall(null);
          if (r.uacCancelled) toast('Installation was cancelled at the Windows administrator prompt.', 'info');
          return r;
        }
        if (r && r.status) applyOffice(r.status);
        if (r && r.rebootRequired) toast('LibreOffice was installed. Windows recommends a restart.', 'info');
        if (r && r.status && r.status.healthy !== true) {
          const message = errorText(new Error(r.status.error || 'LibreOffice was installed, but it could not be verified.'));
          setOfficeInstall({ stage: 'error', percent: 100, message, busy: false, cancellable: false, error: message });
          toast(message, 'error');
        } else {
          setOfficeInstall({ stage: 'done', percent: 100, message: 'LibreOffice is ready.', busy: false, cancellable: false });
          toast('LibreOffice is ready.', 'success');
        }
        return r;
      } catch (e) {
        const message = errorText(e, 'LibreOffice could not be installed.');
        setOfficeInstall({ stage: 'error', percent: 0, message, busy: false, cancellable: false, error: message });
        toast(message, 'error');
        return null;
      } finally {
        officeInstallRef.current = null;
      }
    })();
    officeInstallRef.current = promise;
    return promise;
  }, [applyOffice, toast]);

  /** Stop a download before Windows Installer takes over. */
  const cancelOfficeInstall = useCallback(async () => {
    try {
      const stopped = await api.officeInstallCancel();
      if (stopped) setOfficeInstall((p) => (p ? { ...p, message: 'Cancelling…', cancellable: false } : p));
    } catch (e) {
      toast(errorText(e, 'Could not cancel the LibreOffice download.'), 'error');
    }
  }, [toast]);

  // Older UI code used this name; keep it as an alias so nothing breaks.
  const downloadOffice = installOffice;

  useEffect(() => {
    let alive = true;
    api.info().then((i) => {
      if (!alive) return;
      setInfo(i);
      officeRef.current = i.office || null;
      setOffice(i.office || null);
      document.documentElement.dataset.theme = (i.settings && i.settings.theme) || 'dark';
      if (i.outputNote) setTimeout(() => { if (alive) toast(i.outputNote, 'info'); }, 800);
      // Paint immediately with the fast path check, then confirm the executable
      // really starts. This keeps startup snappy without trusting a stale path.
      // refreshOffice() is single-flight, so the gate and this call share it.
      if (i.office && i.office.installed) refreshOffice();
    }).catch((e) => {
      if (alive) toast(errorText(e, 'MorphEra could not load its settings.'), 'error');
    });
    loadHistory();
    const offInstall = api.onOfficeInstall ? api.onOfficeInstall((p) => {
      if (!p || !p.stage) return;
      if (p.stage === 'cancelled') { setOfficeInstall(null); return; }
      setOfficeInstall((prev) => ({
        ...(prev || {}),
        ...p,
        busy: !['done', 'error'].includes(p.stage),
      }));
    }) : () => {};
    const offOffice = api.onOfficeStatus ? api.onOfficeStatus((status) => {
      const wasInstalled = !!(officeRef.current && officeRef.current.installed);
      applyOffice(status);
      if (status && !status.installed) {
        // Do not leave a completed installer panel on screen after the app is
        // re-gated because LibreOffice was removed outside MorphEra.
        setOfficeInstall((p) => (p && p.busy ? p : null));
        if (wasInstalled) toast('LibreOffice is no longer available. Install it again to convert documents.', 'error');
      }
    }) : () => {};
    const off1 = api.onJob((u) => {
      setJobs((j) => ({ ...j, [u.id]: { ...(j[u.id] || {}), ...u, meta: metaRef.current[u.id] || (j[u.id] && j[u.id].meta) } }));
    });
    const offClear = api.onJobClear ? api.onJobClear(removeJobRows) : () => {};
    const off2 = api.onHistory(loadHistory);
    const off3 = api.onWatch((w) => {
      metaRef.current[w.id] = { name: w.file.split(/[\\/]/).pop(), kind: 'watch', to: w.to };
      toast(`Watch folder: converting ${w.file.split(/[\\/]/).pop()}`, 'info');
    });
    return () => { alive = false; offInstall(); offOffice(); off1(); offClear(); off2(); off3(); };
  }, [applyOffice, loadHistory, toast, refreshOffice, removeJobRows]);

  // Surface otherwise-silent async failures instead of leaving the UI stuck.
  useEffect(() => {
    const recent = new Map();
    const report = (message) => {
      const text = String(message || 'Something went wrong.').replace(/^Error:\s*/, '').trim();
      if (!text || /cancelled|canceled|aborted/i.test(text)) return;
      const now = Date.now();
      if (recent.get(text) && now - recent.get(text) < 4000) return;
      recent.set(text, now);
      if (recent.size > 40) recent.clear();
      toast(text.length > 300 ? text.slice(0, 300) + '…' : text, 'error');
    };
    const onRejection = (e) => {
      const reason = e && e.reason;
      console.error('[MorphEra] unhandled rejection', reason);
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      report(reason && (reason.message || reason));
    };
    const onError = (e) => {
      console.error('[MorphEra] uncaught error', e && (e.error || e.message));
      report(e && ((e.error && e.error.message) || e.message));
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => { window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('error', onError); };
  }, [toast]);

  const run = useCallback(async (specs, metas) => {
    try {
      const preflight = await api.officePreflight(specs);
      if (preflight && preflight.needed && !preflight.installed) {
        applyOffice(preflight.status);
        return [];
      }
    } catch (e) {
      // Keep the conversion attempt going; the main process checks again
      // before LibreOffice is launched and will report any real failure.
      console.error('[MorphEra] dependency preflight failed', e);
    }
    const ids = await api.start(specs);
    ids.forEach((id, i) => {
      const meta = metas[i] || {};
      metaRef.current[id] = meta;
      setJobs((j) => ({ ...j, [id]: { id, status: 'queued', progress: 0, label: 'Waiting', outputs: [], meta, spec: specs[i] } }));
    });
    return ids;
  }, [applyOffice]);

  const setSettings = useCallback(async (patch) => {
    const r = await api.setSettings(patch);
    setInfo((i) => ({ ...i, settings: r.settings, outputDir: r.outputDir, outputNote: r.outputNote }));
    if (patch.theme) document.documentElement.dataset.theme = patch.theme;
    return r;
  }, []);

  const registerDrop = useCallback((fn) => { dropRef.current = fn; return () => { if (dropRef.current === fn) dropRef.current = null; }; }, []);

  // global drop + paste
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true); };
    const over = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDragging(false);
      try {
        const paths = Array.from(e.dataTransfer.files).map((f) => api.pathOf(f)).filter(Boolean);
        if (paths.length && dropRef.current) await dropRef.current(paths);
      } catch (err) {
        console.error('[MorphEra] drop failed', err);
        if (!/cancel/i.test(String((err && err.message) || ''))) toast(errorText(err, 'Those files could not be opened.'), 'error');
      }
    };
    const paste = async (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA/.test(tag)) return;
      try {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
        let paths = files.map((f) => api.pathOf(f)).filter(Boolean);
        if (!paths.length && files.length) {
          for (const f of files) { if (/^image\//.test(f.type)) paths.push(await api.saveClipboardImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1].replace('jpeg', 'jpg'))); }
        }
        if (!paths.length) { const p = await api.readClipboardImage(); if (p) paths = [p]; }
        if (paths.length && dropRef.current) { e.preventDefault(); await dropRef.current(paths); }
      } catch (err) {
        console.error('[MorphEra] paste failed', err);
        toast(errorText(err, 'The clipboard image could not be pasted.'), 'error');
      }
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); window.removeEventListener('paste', paste); };
  }, [toast]);

  const value = useMemo(() => ({
    info, route, setRoute, jobs, run, toast, toasts, history, loadHistory, setSettings, registerDrop, dragging,
    dockOpen, dockMode, setDockOpen, toggleDock, setJobs, clearFinishedJobs,
    office, officeBusy, refreshOffice, locateOffice, downloadOffice,
    officeInstall, installOffice, cancelOfficeInstall,
  }), [info, route, jobs, run, toast, toasts, history, loadHistory, setSettings, registerDrop, dragging, dockOpen, dockMode, setDockOpen, toggleDock, clearFinishedJobs, office, officeBusy, refreshOffice, locateOffice, downloadOffice, officeInstall, installOffice, cancelOfficeInstall]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDrop(handler) {
  const { registerDrop } = useApp();
  const ref = useRef(handler);
  const enabled = !!handler;
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    return registerDrop((paths) => {
      const fn = ref.current;
      return fn ? fn(paths) : undefined;
    });
  }, [registerDrop, enabled]);
}

export function useJob(id) {
  const { jobs } = useApp();
  return id ? jobs[id] : undefined;
}
