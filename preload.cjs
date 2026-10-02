'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = [
  'state',
  'create',
  'start',
  'action',
  'undo',
  'send',
  'stop',
  'respond',
  'details',
  'open',
  'project',
  'settings',
  'window',
  'pair',
  'connect',
  'disconnect',
  'revoke',
  'updates',
];
const api = {};
for (const method of methods)
  api[method] = (data) => ipcRenderer.invoke('work-updates:' + method, data);
api.subscribe = (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on('work-updates:state', listener);
  return () => ipcRenderer.removeListener('work-updates:state', listener);
};
contextBridge.exposeInMainWorld('workUpdates', Object.freeze(api));
