'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hyphenChannels', {
  call: (value) => ipcRenderer.invoke('hyphen:channels', value),
});
