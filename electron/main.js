'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Notification, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const U = require('./util');
const F = require('./formats');
const LO = require('./libreoffice');
const LOInstall = require('./libreoffice-install');
const officeRuntime = require('./libreoffice-runtime');
const docs = require('./engines/docs');
const background = require('./engines/background');

const ROOT = path.join(__dirname, '..');
const DEV = !!process.env.MORPH_DEV;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } },
]);

// A second copy must not initialize the protocol, workers or shared temp
// folder: the first instance owns those resources and receives the
// "second-instance" notification instead.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

/* ----------------------------------------------------------------- settings */
let settings = { theme: 'dark', outputMode: 'beside', customOutput: '', libreOfficePath: '', notify: true, openAfter: false, watch: { enabled: false, folder: '', rules: { image: 'webp', video: 'mp4', audio: 'mp3', document: 'pdf' }, preset: '' } };
let settingsFile;
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; settings.watch = { ...{ enabled: false, folder: '', rules: {}, preset: '' }, ...settings.watch }; } catch { /* first run */ }
}
function saveSettings() { try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch { /* ignore */ } }

/* ------------------------------------------------------------ output folder */
function exeDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(process.execPath);
  return path.join(ROOT, 'release-test');
}
function writable(dir) {
  try { U.ensureDir(dir); const t = path.join(dir, `.w${process.pid}`); fs.writeFileSync(t, '1'); fs.unlinkSync(t); return true; } catch { return false; }
}
let outputNote = '';
function resolveOutputDir() {
  outputNote = '';
  if (settings.outputMode === 'custom' && settings.customOutput && writable(settings.customOutput)) return settings.customOutput;
  const base = exeDir();
  const dir = settings.outputMode === 'folder' ? path.join(base, 'MorphEra Files') : base;
  if (writable(dir)) return dir;
  const fallback = path.join(app.getPath('desktop'), 'MorphEra Files');
  outputNote = 'The folder next to MorphEra is read-only, so files are saved to your Desktop instead.';
  U.ensureDir(fallback);
  return fallback;
}

/* ------------------------------------------------------------ hidden worker */
let workerWin = null;
let workerReadyFlag = false;
let workerReadyPromise = null;
const pendingCalls = new Map();
let callId = 0;
const WORKER_CALL_TIMEOUT = 10 * 60 * 1000;

function appUrl(rel) { return 'app://local/' + rel.replace(/\\/g, '/'); }

function rejectPending(reason) {
  for (const [, p] of pendingCalls) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pendingCalls.clear();
}

/**
 * Tear the hidden page engine down. The engine is disposable: if it fails to
 * start or crashes, the next call creates a fresh one instead of staying in a
 * permanently rejected state.
 */
function resetWorker(reason) {
  const w = workerWin;
  workerWin = null;
  workerReadyFlag = false;
  workerReadyPromise = null;
  if (w) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
  if (reason) rejectPending(reason);
}

function ensureWorker() {
  if (workerWin && !workerWin.isDestroyed() && workerReadyFlag) return Promise.resolve();
  if (workerReadyPromise) return workerReadyPromise;

  const w = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(__dirname, 'worker-preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  workerWin = w;

  workerReadyPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => { clearTimeout(timer); ipcMain.removeListener('worker:ready', onReady); };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (workerWin === w) { workerWin = null; workerReadyFlag = false; workerReadyPromise = null; }
      try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      workerReadyFlag = true;
      resolve();
    };

    timer = setTimeout(() => fail(new Error('The page engine did not start. Please try again.')), 20000);
    ipcMain.on('worker:ready', onReady);

    w.on('closed', () => {
      const current = workerWin === w;
      if (current) { workerWin = null; workerReadyFlag = false; workerReadyPromise = null; }
      if (!settled) { fail(new Error('The page engine stopped. Please try again.')); return; }
      if (current) rejectPending('The page engine stopped.');
    });
  });

  w.loadURL(appUrl('electron/worker/worker.html')).catch(() => {
    // A failed load emits "closed", which settles the promise above. Destroy
    // defensively in case the event never fires.
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
  });
  return workerReadyPromise;
}

ipcMain.on('worker:res', (_e, msg) => {
  if (!msg || typeof msg !== 'object') return;
  const p = pendingCalls.get(msg.id);
  if (!p) return;
  pendingCalls.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'The page engine failed.'));
});

const workerService = {
  async call(fn, args) {
    await ensureWorker();
    const w = workerWin;
    if (!w || w.isDestroyed() || !workerReadyFlag) throw new Error('The page engine is not available. Please try again.');
    return new Promise((resolve, reject) => {
      const id = ++callId;
      const timer = setTimeout(() => {
        if (!pendingCalls.has(id)) return;
        pendingCalls.delete(id);
        reject(new Error('The page engine took too long to respond. Please try again.'));
      }, WORKER_CALL_TIMEOUT);
      pendingCalls.set(id, { resolve, reject, timer });
      try {
        w.webContents.send('worker:req', { id, fn, args });
      } catch {
        clearTimeout(timer);
        pendingCalls.delete(id);
        reject(new Error('The page engine stopped. Please try again.'));
      }
    });
  },
};

/* ------------------------------------------------------------- html -> pdf */
async function printHtmlToPdf(html, o = {}) {
  const tmp = U.tmpFile('html', 'print');
  fs.writeFileSync(tmp, html, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1000, height: 1400, webPreferences: { sandbox: true, javascript: false, offscreen: false } });
  try {
    await win.loadURL(pathToFileURL(tmp).href);
    await new Promise((r) => setTimeout(r, 250));
    return await win.webContents.printToPDF({ pageSize: 'A4', landscape: !!o.landscape, printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally { win.destroy(); U.rmQuiet(tmp); }
}

const services = {
  worker: workerService,
  printHtmlToPdf,
  renderText: (o) => workerService.call('renderText', [o]).then((b) => Buffer.from(b)),
  ocr: null,
};
services.ocr = require('./engines/ocr');

/* ------------------------------------------------------------------- state */
let win = null;
let queue = null;
let officePollTimer = null;
let officeFocusTimer = null;
const history = { file: '', items: [] };
function loadHistory() { try { history.items = JSON.parse(fs.readFileSync(history.file, 'utf8')); } catch { history.items = []; } }
function saveHistory() { try { fs.writeFileSync(history.file, JSON.stringify(history.items.slice(0, 300))); } catch { /* ignore */ } }

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

function startQueue() {
  queue = new (require('./jobs').Queue)({
    getOutDir: resolveOutputDir,
    services,
    onUpdate: (u) => {
      send('job:update', u);
      if (['done', 'error', 'cancelled'].includes(u.status)) {
        const job = queue.jobs.get(u.id);
        if (u.status === 'error' && job && specNeedsOffice(job.spec)) {
          // A document job can fail because LibreOffice was removed while the
          // app was open. Recheck the dependency and let the setup gate return.
          verifyOfficeAfterJobFailure();
        }
        if (u.status === 'done') {
          const names = (u.outputs || []).map((p) => path.basename(p));
          history.items.unshift({ id: u.id, time: Date.now(), source: job.spec.file ? path.basename(job.spec.file) : (job.spec.files || []).map((f) => path.basename(f)).join(', '),
            kind: job.spec.kind, to: job.spec.to || '', outputs: u.outputs, name: names.length > 1 ? `${names.length} files` : names[0] || '', sizeOut: (u.outputs || []).reduce((a, p) => a + U.fileSize(p), 0), sizeIn: job.spec.file ? U.fileSize(job.spec.file) : 0, folder: job.folder || '' });
          saveHistory();
          send('history:changed', null);
          if (settings.openAfter && u.outputs && u.outputs[0]) shell.showItemInFolder(u.outputs[0]);
        }
      }
    },
    onIdle: (n) => {
      if (settings.notify && Notification.isSupported() && !(win && win.isFocused())) {
        new Notification({ title: 'MorphEra', body: n === 1 ? 'Your file is ready.' : `${n} files are ready.`, silent: false }).show();
      }
      if (win && !win.isFocused()) { win.flashFrame(true); }
    },
  });
}

/* ------------------------------------------------------------- file info */
function describe(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const ext = F.norm(U.extOf(p));
    const category = F.categoryOf(ext);
    const t = F.targetsFor(ext);
    return { path: p, name: path.basename(p), ext, size: st.size, category, isDir: false, targets: t, suggest: (F.SUGGEST[ext] || []).filter((x) => t.some((y) => y.ext === x)), supported: !!category };
  } catch {
    // A file can disappear between the drop and the description call.
    return null;
  }
}
function expandPaths(paths) {
  const out = [];
  for (const p of (Array.isArray(paths) ? paths : [])) {
    if (typeof p !== 'string' || !p) continue;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) { for (const f of fs.readdirSync(p)) { const fp = path.join(p, f); try { if (fs.statSync(fp).isFile()) out.push(fp); } catch { /* skip */ } } }
      else out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

const ALL_EXT = [...F.IMAGE_IN, ...F.VIDEO_IN, ...F.AUDIO_IN, ...F.DOC_IN];

/* ------------------------------------------------------------ LibreOffice */
function useOfficePath(bin) {
  // Keep util's synchronous helper pointed at the same executable the status
  // calls found, so document conversions never disagree with the gate. Clear
  // it when nothing was found so a removed installation cannot linger.
  try { U.configure({ libreOfficePath: bin || '' }); } catch { /* ignore */ }
}

async function officeStatus(opts = {}) {
  try {
    const s = await LO.detect({ verify: opts.verify !== false, force: true });
    useOfficePath(s.path);
    return s;
  } catch (e) {
    useOfficePath('');
    return {
      installed: false, healthy: false, verified: true, path: null, version: null,
      platform: process.platform, arch: process.arch, autoInstall: process.platform === 'win32',
      downloadUrl: LO.DOWNLOAD_URL, instructions: LO.instructions(),
      checkedAt: Date.now(), warning: null, error: (e && e.message) || 'LibreOffice could not be checked.',
    };
  }
}

function officeGateResult(s, extra) {
  // Locating a bad executable should not silently fall back to an unrelated
  // installation: report it so the gate can show an actionable message.
  return { ...s, ...(extra || {}) };
}

let knownOffice = { installed: null, path: null };
let quickOfficePromise = null;
let failureOfficePromise = null;

/** Track only availability, so a quick check cannot downgrade a verified status. */
function rememberOffice(status) {
  const next = { installed: !!(status && status.installed), path: (status && status.path) || null };
  const changed = knownOffice.installed !== next.installed || knownOffice.path !== next.path;
  knownOffice = next;
  return changed;
}

function publishOffice(status) {
  if (status) send('office:status', status);
}

/** Cheap existence check used when the window regains focus and by the idle poll. */
function quickOfficeCheck(opts = {}) {
  if (quickOfficePromise) return quickOfficePromise;
  quickOfficePromise = (async () => {
    const status = await officeStatus({ verify: false });
    const changed = rememberOffice(status);
    if (changed && opts.announce !== false) publishOffice(status);
    return status;
  })().finally(() => { quickOfficePromise = null; });
  return quickOfficePromise;
}

/**
 * When a document conversion fails, distinguish a removed installation from a
 * bad file. A quick check catches a missing executable immediately; otherwise
 * one full verification gives the gate an accurate message.
 */
function verifyOfficeAfterJobFailure() {
  if (failureOfficePromise) return failureOfficePromise;
  failureOfficePromise = (async () => {
    const quick = await quickOfficeCheck({ announce: false });
    if (!quick.installed) {
      publishOffice(quick);
      return;
    }
    const status = await officeStatus({ verify: true });
    rememberOffice(status);
    publishOffice(status);
  })().catch((e) => {
    console.error('[morph] LibreOffice recheck failed', e);
  }).finally(() => { failureOfficePromise = null; });
  return failureOfficePromise;
}

function specNeedsOffice(spec) {
  if (!spec || spec.kind !== 'convert') return false;
  const source = spec.file || (Array.isArray(spec.files) && spec.files[0]) || '';
  return docs.needsOffice(U.extOf(source), spec.to || '');
}

let officeInstallPromise = null;

function sendInstallProgress(sender, payload) {
  try {
    if (sender && !sender.isDestroyed()) sender.send('office:install-progress', payload);
  } catch { /* renderer already closed */ }
}

/**
 * After a silent install, Windows can take a moment to register the new
 * product and release the MSI transaction. Poll briefly, then let normal
 * detection (including its timeout tolerance) report the final state.
 */
async function verifyOfficeAfterInstall() {
  const deadline = Date.now() + 60 * 1000;
  let last = null;
  for (;;) {
    LO.invalidate();
    last = await officeStatus({ verify: true });
    if (last.healthy === true || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Download and install LibreOffice. The native dialog is intentionally shown
 * only when an existing product is present, so a first-time install starts
 * with the click that opened the gate. All installation work is single-flight.
 */
function installOffice(event) {
  if (officeInstallPromise) return officeInstallPromise;
  const sender = event && event.sender;
  officeInstallPromise = (async () => {
    if (process.platform !== 'win32') {
      try { await shell.openExternal(LO.DOWNLOAD_URL); } catch { /* shown below */ }
      return { manual: true, cancelled: false, status: await officeStatus({ verify: true }) };
    }

    const fast = await officeStatus({ verify: false });
    let products = [];
    try { products = await LOInstall.uninstallEntries(); } catch { /* detection still works */ }
    const installed = !!(fast.path || products.length);

    if (installed) {
      const existing = products[0];
      const parent = BrowserWindow.fromWebContents(sender) || win;
      const options = {
        type: 'question',
        buttons: ['Clean reinstall', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'LibreOffice is already installed',
        message: 'LibreOffice is already installed on your system. Do you want to clean-reinstall the latest version?',
        detail: [
          existing ? `Detected: ${existing.name}${existing.version ? ` (${existing.version})` : ''}` : (fast.path ? `Detected: ${fast.path}` : 'LibreOffice is registered on this computer.'),
          '',
          'MorphEra will remove the existing LibreOffice installation, download the latest stable installer from the official Document Foundation mirror, verify its signature, and install it silently.',
          '',
          'Save your work and close any open LibreOffice windows before continuing.',
        ].join('\n'),
      };
      const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (choice.response !== 0) return { cancelled: true, status: fast };
    }

    sendInstallProgress(sender, {
      stage: 'preparing', percent: 1, message: 'Preparing the LibreOffice installer…', cancellable: true,
    });

    let result;
    try {
      result = await LOInstall.install({
        uninstallCodes: products.map((p) => p.code),
        onProgress: (payload) => sendInstallProgress(sender, payload),
      });
    } catch (e) {
      if (LOInstall.isCancelled(e)) {
        return {
          cancelled: true,
          uacCancelled: /administrator prompt/i.test(String(e && e.message || '')),
          status: await officeStatus({ verify: false }),
        };
      }
      throw e;
    }

    // The automatic installer always lays down the standard system install.
    // Drop a stale custom path so the final verification cannot prefer the
    // product that was just uninstalled.
    settings.libreOfficePath = '';
    saveSettings();
    LO.configure({ customPath: '' });
    useOfficePath('');

    sendInstallProgress(sender, {
      stage: 'verifying', percent: 98, message: 'LibreOffice is installed. Verifying the document engine…', cancellable: false,
    });

    const status = await verifyOfficeAfterInstall();
    useOfficePath(status.path);
    rememberOffice(status);
    sendInstallProgress(sender, {
      stage: 'done',
      percent: 100,
      message: status.healthy === true ? 'LibreOffice is ready.' : 'LibreOffice was installed, but it could not be verified.',
      cancellable: false,
      version: result.version,
    });
    return {
      cancelled: false,
      status,
      version: result.version,
      rebootRequired: !!result.rebootRequired,
      bytes: result.bytes,
    };
  })().finally(() => { officeInstallPromise = null; });
  return officeInstallPromise;
}

/* --------------------------------------------------------------- ipc setup */
function ipc() {
  ipcMain.handle('app:info', async () => {
    const office = await officeStatus({ verify: false });
    rememberOffice(office);
    return {
      version: app.getVersion(), outputDir: resolveOutputDir(), outputNote,
      hasOffice: !!office.path, office,
      features: { backgroundRemoval: background.available() },
      presets: Object.values(F.PRESETS).map((p) => ({ id: p.id, label: p.label, blurb: p.blurb, image: !!p.image, video: !!p.video, audio: !!p.audio, pdf: !!p.pdf })),
      settings, platform: process.platform,
    };
  });
  ipcMain.handle('files:describe', (_e, paths) => expandPaths(paths).map(describe).filter(Boolean));
  ipcMain.handle('files:pick', async (_e, o = {}) => {
    const filters = o.filters || [{ name: 'Supported files', extensions: ALL_EXT }, { name: 'All files', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('files:pickFolder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? '' : r.filePaths[0]; });
  ipcMain.handle('files:saveClipboardImage', (_e, bytes, ext = 'png') => {
    const cleanExt = [ 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp' ].includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'png';
    const data = Buffer.from(bytes || []);
    if (!data.length || data.length > 64 * 1024 * 1024) throw new Error('The pasted image is empty or too large.');
    const p = U.tmpFile(cleanExt, 'pasted');
    fs.writeFileSync(p, data);
    const named = path.join(path.dirname(p), `Pasted image ${Date.now()}.${cleanExt}`);
    fs.renameSync(p, named);
    return named;
  });
  ipcMain.handle('clipboard:readImage', () => { const img = clipboard.readImage(); if (img.isEmpty()) return null; U.ensureDir(U.getState().tmpRoot); const p = path.join(U.getState().tmpRoot, `Pasted image ${Date.now()}.png`); fs.writeFileSync(p, img.toPNG()); return p; });

  // ---- LibreOffice -----------------------------------------------------------------
  ipcMain.handle('office:status', async (_e, opts = {}) => {
    const status = await officeStatus({ verify: opts && opts.verify === false ? false : true });
    rememberOffice(status);
    return status;
  });
  ipcMain.handle('office:recheck', async () => {
    const status = await officeStatus({ verify: true });
    rememberOffice(status);
    return status;
  });
  ipcMain.handle('office:preflight', async (_e, specs) => {
    const list = Array.isArray(specs) ? specs.slice(0, 100) : [];
    if (!list.some(specNeedsOffice)) return { needed: false, installed: true, status: null };
    const status = await officeStatus({ verify: false });
    const changed = rememberOffice(status);
    if (!status.installed) publishOffice(status);
    else if (changed) publishOffice(status);
    return { needed: true, installed: !!status.installed, status };
  });
  ipcMain.handle('office:install', (event) => installOffice(event));
  ipcMain.handle('office:install-cancel', () => LOInstall.cancel());
  ipcMain.handle('office:download', async () => { try { await shell.openExternal(LO.DOWNLOAD_URL); return true; } catch { return false; } });
  ipcMain.handle('office:locate', async () => {
    const filters = process.platform === 'win32'
      ? [{ name: 'LibreOffice program', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(win, {
      title: 'Locate LibreOffice', buttonLabel: 'Use this program', properties: ['openFile'], filters,
    });
    if (r.canceled || !r.filePaths[0]) return null;

    const picked = LO.resolveUserPath(r.filePaths[0]);
    if (!LO.isExecutable(picked)) {
      const s = await officeStatus({ verify: false });
      return officeGateResult(s, {
        installed: !!s.path, healthy: false,
        error: process.platform === 'win32'
          ? 'That file cannot be run. Choose soffice.exe inside the LibreOffice “program” folder.'
          : 'That file cannot be run. Choose the “soffice” program inside your LibreOffice installation.',
      });
    }

    const s = await LO.detect({ verify: true, force: true, customPath: picked });
    if (!s.installed || s.healthy !== true) {
      return officeGateResult(s, {
        installed: !!s.path,
        healthy: false,
        error: s.error || 'That program is not LibreOffice, or it could not be started. Choose the LibreOffice program file and try again.',
      });
    }

    settings.libreOfficePath = s.path || picked;
    saveSettings();
    LO.configure({ customPath: settings.libreOfficePath });
    useOfficePath(settings.libreOfficePath);
    rememberOffice(s);
    return s;
  });

  ipcMain.handle('jobs:start', (_e, specs) => (Array.isArray(specs) ? specs : []).map((s) => queue.add(s)));
  ipcMain.handle('jobs:cancel', (_e, id) => queue.cancel(id));
  ipcMain.handle('jobs:cancelAll', () => queue.cancelAll());
  ipcMain.handle('jobs:clearFinished', () => {
    const removed = queue.clearFinished();
    if (removed.length) send('job:cleared', removed);
    return removed;
  });

  const ctxFor = () => ({ signal: new AbortController().signal, outDir: U.tmpDir('preview'), services, progress: () => {} });
  ipcMain.handle('image:preview', async (_e, file, edge) => {
    const maxEdge = Math.max(240, Math.min(4096, Number(edge) || 1800));
    return require('./engines/image').previewImage(ctxFor(), file, maxEdge);
  });
  ipcMain.handle('image:info', async (_e, file) => require('./engines/image').imageInfo(ctxFor(), file));
  ipcMain.handle('image:trial', async (_e, spec) => {
    // Runs a conversion into a temp folder and returns a preview + the size, for before/after.
    if (!spec || typeof spec !== 'object') throw new Error('Nothing to preview.');
    const ctx = ctxFor();
    try {
      const res = await require('./jobs').runJob(ctx, spec);
      const out = res && res.outputs && res.outputs[0];
      if (!out || !fs.existsSync(out)) throw new Error('The preview could not be created.');
      const prev = await require('./engines/image').previewImage(ctx, out, 1600).catch(() => null);
      return { size: U.fileSize(out), preview: prev && prev.dataUrl, width: prev && prev.width, height: prev && prev.height };
    } finally { U.rmQuiet(ctx.outDir); }
  });
  ipcMain.handle('media:info', async (_e, file) => require('./engines/media').probe(file));
  ipcMain.handle('media:frames', async (_e, file, times, height = 90) => {
    const media = require('./engines/media');
    const h = Math.max(32, Math.min(480, Number(height) || 90));
    const list = (Array.isArray(times) ? times : []).slice(0, 24).map((t) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0);
    const out = [];
    for (const t of list) {
      const p = U.tmpFile('jpg', 'frame');
      try {
        await media.runFfmpeg({}, ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=-2:${h}`, '-q:v', '5', p], { noProgress: true, timeoutMs: 60000 });
        out.push('data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64'));
      } catch { out.push(''); } finally { U.rmQuiet(p); }
    }
    return out;
  });
  ipcMain.handle('media:fileUrl', (_e, file) => appUrl('@file/' + encodeURIComponent(file)));
  ipcMain.handle('pdf:info', async (_e, file, password) => require('./engines/pdf').pdfInfo(ctxFor(), { file, password }));
  ipcMain.handle('pdf:thumbs', async (_e, file, pages, password, edge) => require('./engines/pdf').thumbnails(ctxFor(), { file, pages, password, maxEdge: edge }));

  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:show', (_e, p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); else shell.openPath(path.dirname(p)); });
  ipcMain.handle('shell:openOutput', () => shell.openPath(resolveOutputDir()));

  ipcMain.handle('history:get', () => history.items);
  ipcMain.handle('history:clear', () => { history.items = []; saveHistory(); });
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = rawPatch && typeof rawPatch === 'object' ? rawPatch : {};
    settings = { ...settings, ...patch, watch: { ...settings.watch, ...(patch.watch || {}) } };
    if (patch.watch && patch.watch.rules) settings.watch.rules = { ...settings.watch.rules };
    if (Object.prototype.hasOwnProperty.call(patch, 'libreOfficePath')) {
      settings.libreOfficePath = String(patch.libreOfficePath || '');
      LO.configure({ customPath: settings.libreOfficePath });
      LO.invalidate();
      useOfficePath(settings.libreOfficePath);
    }
    saveSettings();
    if (patch.watch) applyWatch();
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'light' ? 'light' : 'dark';
    return { settings, outputDir: resolveOutputDir(), outputNote };
  });

  ipcMain.on('win:min', () => win && win.minimize());
  ipcMain.on('win:max', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  ipcMain.on('win:close', () => win && win.close());
}

/* ------------------------------------------------------------ watch folder */
let watcher = null;
const seen = new Set();
function applyWatch() {
  if (watcher) { watcher.close(); watcher = null; }
  const w = settings.watch;
  if (!w.enabled || !w.folder || !fs.existsSync(w.folder)) return;
  const chokidar = require('chokidar');
  const outDir = path.join(w.folder, 'MorphEra Converted');
  watcher = chokidar.watch(w.folder, { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 }, ignored: (p) => path.basename(p).startsWith('.') || p.includes('MorphEra Converted') });
  watcher.on('error', (e) => { console.error('[morph] watch folder error', e); });
  watcher.on('add', (p) => {
    try {
      if (seen.has(p)) return; seen.add(p);
      const ext = F.norm(U.extOf(p));
      const cat = F.categoryOf(ext);
      const to = cat && w.rules && w.rules[cat];
      if (!cat || !to || to === 'skip' || to === ext) return;
      if (!F.targetsFor(ext).some((t) => t.ext === to)) return;
      const id = queue.add({ kind: 'convert', file: p, to, preset: w.preset || '', outDir, opts: {}, edits: {}, watch: true });
      send('watch:hit', { id, file: p, to });
    } catch (e) {
      // A single unwritable file must not stop the watcher.
      console.error('[morph] watch conversion could not start', e);
    }
  });
}

/* ------------------------------------------------------------------ window */
function createWindow() {
  const icon = path.join(ROOT, 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 940, minHeight: 640, frame: false, show: false, backgroundColor: '#0b0d1a', title: 'MorphEra',
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:state', { max: true }));
  win.on('unmaximize', () => send('win:state', { max: false }));
  win.on('focus', () => {
    win.flashFrame(false);
    clearTimeout(officeFocusTimer);
    // Give the window a moment to settle after a native dialog or UAC prompt.
    officeFocusTimer = setTimeout(() => {
      quickOfficeCheck().catch((e) => console.error('[morph] LibreOffice check failed', e));
    }, 350);
  });
  win.on('closed', () => {
    clearTimeout(officeFocusTimer);
    clearTimeout(officePollTimer);
    win = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', (_e, d) => console.error('[morph] renderer gone', d && d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[morph] page failed to load', code, desc));
  win.loadURL(DEV ? 'http://localhost:5173' : appUrl('dist/index.html')).catch((e) => console.error('[morph] loadURL failed', e));
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  const data = app.getPath('userData');
  U.ensureDir(data);
  settingsFile = path.join(data, 'settings.json');
  history.file = path.join(data, 'history.json');
  U.configure({ tmpRoot: path.join(os.tmpdir(), 'MorphEra'), dataDir: data });
  loadSettings();
  LO.configure({ customPath: settings.libreOfficePath || '' });
  useOfficePath(settings.libreOfficePath || '');
  loadHistory();
  nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';

  protocol.handle('app', (req) => {
    try {
      const u = new URL(req.url);
      let rel;
      try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, ''); } catch { return new Response('bad request', { status: 400 }); }

      if (rel.startsWith('@file/')) {
        // Local media for the preview player. Only this app's own window can
        // request this scheme. Restrict it to real audio/video files so a
        // compromised renderer cannot read arbitrary documents through it.
        const abs = rel.slice(6);
        if (!path.isAbsolute(abs)) return new Response('not found', { status: 404 });
        const ext = F.norm(U.extOf(abs));
        if (!F.VIDEO_IN.includes(ext) && !F.AUDIO_IN.includes(ext) && ext !== 'gif') return new Response('not found', { status: 404 });
        try { if (!fs.statSync(abs).isFile()) return new Response('not found', { status: 404 }); }
        catch { return new Response('not found', { status: 404 }); }
        return net.fetch(pathToFileURL(abs).href, { headers: req.headers });
      }

      const full = path.resolve(ROOT, rel);
      const inside = full === ROOT || full.startsWith(ROOT + path.sep);
      if (!inside) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(full).href);
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  startQueue(); ipc(); createWindow(); applyWatch();
  officePollTimer = setInterval(() => {
    if (win && !win.isDestroyed()) {
      quickOfficeCheck().catch((e) => console.error('[morph] LibreOffice check failed', e));
    }
  }, 60000);
  if (officePollTimer.unref) officePollTimer.unref();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}).catch((e) => {
  console.error('[morph] startup failed', e);
  try { dialog.showErrorBox('MorphEra could not start', (e && e.message) || 'An unexpected error occurred while starting the app.'); } catch { /* ignore */ }
  app.quit();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { app.quit(); });

let quitting = false;
app.on('before-quit', () => {
  if (!primaryInstance || quitting) return;
  quitting = true;
  clearTimeout(officePollTimer);
  clearTimeout(officeFocusTimer);
  try { if (watcher) watcher.close(); } catch { /* ignore */ }
  try { if (queue) queue.cancelAll(); } catch { /* ignore */ }
  try { LOInstall.cancel(); } catch { /* ignore */ }
  try { services.ocr.shutdown(); } catch { /* ignore */ }
  try { background.shutdown(); } catch { /* ignore */ }
  try { resetWorker('MorphEra is closing.'); } catch { /* ignore */ }
  try { officeRuntime.shutdownSync(); } catch { /* ignore */ }
  // An elevated msiexec may still be reading the downloaded MSI after the UI
  // has gone away. Leave the installer folder in place; the next run sweeps
  // only folders that are at least an hour old.
  try {
    if (!LOInstall.busy()) U.rmQuiet(path.join(os.tmpdir(), 'MorphEra'));
  } catch { /* best effort */ }
});

// A single bad file or third-party module must never take the whole app down
// silently. Keep the process alive, log, and let the UI report friendly errors.
process.on('uncaughtException', (e) => { console.error('[morph] uncaught exception', e); });
process.on('unhandledRejection', (e) => { console.error('[morph] unhandled rejection', e); });
