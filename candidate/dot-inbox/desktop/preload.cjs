'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function stored(channel, value) {
  const result = ipcRenderer.sendSync(channel, value);
  if (!result?.ok) throw new Error(result?.error || 'Review recovery storage unavailable.');
  return result.value;
}
contextBridge.exposeInMainWorld('dotDesktop', {
  bootstrap: () => ipcRenderer.invoke('dot-review:bootstrap'),
  setExpanded: (expanded, userInitiated) =>
    ipcRenderer.invoke('dot-review:window', { expanded, userInitiated }),
  recovery: {
    read: () => stored('dot-review:read'),
    write: (value) => stored('dot-review:write', value),
  },
  onCollapse: (callback) => ipcRenderer.on('dot-review:collapse', () => callback()),
  onTools: (callback) => ipcRenderer.on('dot-review:tools', () => callback()),
});
