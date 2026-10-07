'use strict';
const path = require('node:path'),
  crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
class VoiceWindow {
  constructor({ BrowserWindow, session, ipcMain, ledger, provider, actorId }) {
    Object.assign(this, { BrowserWindow, session, ipcMain, ledger, provider, actorId });
    this.file = path.join(__dirname, '../ui/voice.html');
    this.names = [
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
    ];
    for (const name of this.names)
      ipcMain.handle('hyphen:voice:' + name, async (event, value) => {
        try {
          if (
            !this.window ||
            event.sender !== this.window.webContents ||
            event.senderFrame?.url !== pathToFileURL(this.file).href
          )
            throw new Error('Select the private voice window.');
          return { ok: true, value: await this.action(name, value) };
        } catch {
          return {
            ok: false,
            error:
              'Voice is unavailable or held. Check the provider, current consent and session state. No automatic replacement call was made.',
          };
        }
      });
    ledger.options.stopAudio = (id) => this.window?.webContents.send('hyphen:voice:stop', id);
    this.timer = setInterval(() => {
      try {
        ledger.expire();
      } catch {
        this.stop();
      }
    }, 1000);
    this.timer.unref();
  }
  human() {
    return {
      role: 'human',
      authority: 'accepted_human',
      actorId: this.actorId,
      messageId: crypto.randomUUID(),
    };
  }
  async action(name, v = {}) {
    if (name === 'state')
      return {
        ...this.ledger.inspect(),
        contextChoices: this.ledger.options.context?.choices() || {
          choices: [],
          reason: 'Task context unavailable.',
        },
      };
    if (name === 'context') return this.ledger.options.context.preview(v.selection);
    if (name === 'configure') {
      if (this.ledger.live) throw new Error('End voice before changing the provider.');
      return this.provider.configure(v.key);
    }
    if (name === 'begin') return this.ledger.begin(this.human(), v);
    if (name === 'connect') return this.ledger.connect(v.id, v.sdp);
    if (name === 'event') {
      this.ledger.events(v.id, v.event);
      return {};
    }
    if (name === 'steer') return this.ledger.steer(this.human(), v.id, v.text);
    if (name === 'mute') return this.ledger.mute(this.human(), v.id, v.muted);
    if (name === 'end') {
      const result = this.ledger.end(this.human(), v.id);
      this.ledger.options.stopAudio(v.id);
      return result;
    }
    if (name === 'disconnected') return this.ledger.disconnect(v.id);
    throw new Error('Unsupported voice control.');
  }
  open() {
    if (this.window) {
      this.window.show();
      this.window.focus();
      return { opened: true, microphoneStarted: false };
    }
    const partition = this.session.fromPartition('hyphen-voice-' + crypto.randomUUID(), {
      cache: false,
    });
    const allowed = (contents, permission, details) =>
      permission === 'media' &&
      contents === this.window?.webContents &&
      !!this.ledger.live &&
      details?.mediaTypes?.length > 0 &&
      details.mediaTypes.every((x) => x === 'audio');
    partition.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(allowed(contents, permission, details)),
    );
    partition.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        permission === 'media' &&
        contents === this.window?.webContents &&
        !!this.ledger.live &&
        details?.mediaType === 'audio',
    );
    this.window = new this.BrowserWindow({
      width: 660,
      height: 680,
      title: 'Hyphen voice',
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'voice-preload.cjs'),
        session: partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    const owned = this.window;
    owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owned.webContents.on('will-navigate', (event) => event.preventDefault());
    owned.on('close', () => this.stop());
    owned.on('closed', () => {
      if (this.window === owned) this.window = null;
    });
    owned.loadFile(this.file);
    return { opened: true, microphoneStarted: false };
  }
  stop() {
    try {
      this.ledger.close();
    } catch {
      this.ledger.live?.abort.abort();
      this.ledger.live = null;
    } finally {
      this.window?.webContents.send('hyphen:voice:stop', null);
    }
  }
  close() {
    clearInterval(this.timer);
    this.stop();
    this.window?.destroy();
    for (const name of this.names) this.ipcMain.removeHandler('hyphen:voice:' + name);
  }
}
module.exports = { VoiceWindow };
