'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Electron wraps IPC failures in a long "Error invoking remote method ..."
 * prefix. Strip it once here so every page can show the real message.
 */
function cleanError(e) {
  let message = (e && e.message) || String(e || 'Something went wrong.');
  message = String(message)
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .trim();
  const err = new Error(message || 'Something went wrong.');
  err.name = (e && e.name) || 'Error';
  return err;
}

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a).catch((e) => { throw cleanError(e); });
const on = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('morph', {
  info: inv('app:info'),
  describe: inv('files:describe'),
  pick: inv('files:pick'),
  pickFolder: inv('files:pickFolder'),
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  saveClipboardImage: inv('files:saveClipboardImage'),
  readClipboardImage: inv('clipboard:readImage'),
  start: inv('jobs:start'),
  cancel: inv('jobs:cancel'),
  cancelAll: inv('jobs:cancelAll'),
  clearFinished: inv('jobs:clearFinished'),
  imagePreview: inv('image:preview'),
  imageInfo: inv('image:info'),
  imageTrial: inv('image:trial'),
  mediaInfo: inv('media:info'),
  mediaFrames: inv('media:frames'),
  mediaUrl: inv('media:fileUrl'),
  pdfInfo: inv('pdf:info'),
  pdfThumbs: inv('pdf:thumbs'),
  officeStatus: inv('office:status'),
  officeRecheck: inv('office:recheck'),
  officePreflight: inv('office:preflight'),
  officeLocate: inv('office:locate'),
  officeInstall: inv('office:install'),
  officeInstallCancel: inv('office:install-cancel'),
  officeDownload: inv('office:download'),
  onOfficeInstall: on('office:install-progress'),
  onOfficeStatus: on('office:status'),
  open: inv('shell:open'),
  show: inv('shell:show'),
  openOutput: inv('shell:openOutput'),
  history: inv('history:get'),
  clearHistory: inv('history:clear'),
  setSettings: inv('settings:set'),
  onJob: on('job:update'),
  onJobClear: on('job:cleared'),
  onHistory: on('history:changed'),
  onWatch: on('watch:hit'),
  onWinState: on('win:state'),
  win: { min: () => ipcRenderer.send('win:min'), max: () => ipcRenderer.send('win:max'), close: () => ipcRenderer.send('win:close') },
});
