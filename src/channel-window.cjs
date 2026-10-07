'use strict';
const path = require('node:path'),
  crypto = require('node:crypto'),
  { pathToFileURL } = require('node:url');
class ChannelWindow {
  constructor(options) {
    Object.assign(this, options);
    this.file = path.join(__dirname, '../ui/channels.html');
    options.ipcMain.handle('hyphen:channels', async (event, value) => {
      try {
        if (
          !this.window ||
          event.sender !== this.window.webContents ||
          event.senderFrame?.url !== pathToFileURL(this.file).href
        )
          throw new Error();
        return { ok: true, value: await this.action(value) };
      } catch {
        return {
          ok: false,
          error: 'Channel is held. Check ownership consent, device encryption and current grant.',
        };
      }
    });
  }
  human() {
    return {
      role: 'human',
      authority: 'accepted_human',
      actorId: this.channels.actorId,
      messageId: crypto.randomUUID(),
    };
  }
  async action(value) {
    if (value?.method === 'state')
      return { channels: this.channels.inspect(), addresses: require('./peer.cjs').interfaces() };
    if (value?.method === 'invite') return this.invite(this.human(), value.input);
    if (value?.confirmed !== true) throw new Error();
    if (value.method === 'revoke') return this.channels.revoke(this.human(), value.id);
    if (value.method === 'clear') return this.channels.clear(this.human(), value.id);
    throw new Error();
  }
  open() {
    if (this.window?.isDestroyed()) this.window = null;
    if (this.window) {
      this.window.show();
      this.window.focus();
      return;
    }
    const win = new this.BrowserWindow({
      title: 'Private assistant channels',
      width: 640,
      height: 720,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'channel-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    win.loadFile(this.file);
  }
  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ipcMain.removeHandler('hyphen:channels');
  }
}
module.exports = { ChannelWindow };
