'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workerBridge', {
  onRequest: (cb) => ipcRenderer.on('worker:req', (_e, msg) => cb(msg)),
  respond: (msg) => ipcRenderer.send('worker:res', msg),
  ready: () => ipcRenderer.send('worker:ready'),
});
