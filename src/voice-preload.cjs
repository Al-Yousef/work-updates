'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hyphenVoice', {
  call: (name, value) => {
    if (
      ![
        'state',
        'context',
        'configure',
        'begin',
        'connect',
        'event',
        'steer',
        'mute',
        'end',
        'disconnected',
      ].includes(name)
    )
      throw new Error('Unsupported voice control.');
    return ipcRenderer.invoke('hyphen:voice:' + name, value);
  },
  onStop: (callback) => {
    ipcRenderer.on('hyphen:voice:stop', (_, id) => callback(id));
  },
});
