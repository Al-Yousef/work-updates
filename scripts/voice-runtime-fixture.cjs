'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path');
if (process.env.HYPHEN_VOICE_AUDIT !== '1' || !path.isAbsolute(process.argv[2] || ''))
  throw new Error('An owned synthetic voice fixture is required.');
const directory = process.argv[2];
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'electron-profile'));
const { VoiceSession } = require('../src/voice-session.cjs'),
  { VoiceWindow } = require('../src/voice-window.cjs');
let window, ledger;
app.on('window-all-closed', () => {});
app.on('before-quit', () => window?.close());
app.whenReady().then(() => {
  const provider = {
    support: () => ({ provider: 'openai-realtime', model: 'synthetic', configured: true }),
    connect: async () => new Promise(() => {}),
  };
  ledger = new VoiceSession({
    directory,
    actorId: 'human:fixture',
    provider,
    admission: () => 'allow',
  });
  window = new VoiceWindow({
    BrowserWindow,
    session,
    ipcMain,
    ledger,
    provider,
    actorId: ledger.actorId,
  });
  window.open();
  global.voiceFixture = { ledger, window };
});
