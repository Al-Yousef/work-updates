'use strict';
const { app, BrowserWindow, ipcMain } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
if (process.env.HYPHEN_CHANNEL_AUDIT !== '1' || !path.isAbsolute(process.argv[2] || ''))
  throw new Error('Owned synthetic channel fixture required.');
const directory = process.argv[2];
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'electron-profile'));
const { AssistantChannels } = require('../src/assistant-channels.cjs'),
  { ChannelWindow } = require('../src/channel-window.cjs'),
  { HostPeer, parseCode } = require('../src/peer.cjs');
let window, channels, host;
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  window?.close();
  channels?.close();
  host?.close();
});
app.whenReady().then(() => {
  const key = crypto.randomBytes(32),
    actorId = 'human:fixture',
    hostId = crypto.randomUUID();
  const encrypt = (text) => {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]);
  };
  const decrypt = (bytes) => {
    const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    c.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]).toString();
  };
  channels = new AssistantChannels({
    directory,
    actorId,
    hostId,
    epoch: crypto.randomUUID(),
    encrypt,
    decrypt,
    available: () => true,
    admission: () => 'allow',
    snapshot: () => ({ cards: [], done: [], health: { ok: true }, collectedAt: Date.now() / 1000 }),
    provider: () => ({
      answer: async () => {
        throw new Error('No inference in window fixture.');
      },
      close() {},
    }),
  });
  host = new HostPeer({
    directory,
    encrypt,
    decrypt,
    state: () => ({ cards: [], done: [] }),
    assistantChannels: channels,
  });
  window = new ChannelWindow({
    BrowserWindow,
    ipcMain,
    channels,
    invite: async (human, input) => {
      channels.checkInvitation(human, input);
      const endpoint = parseCode(await host.start(input.host));
      const grant = channels.invite(human, input);
      return {
        code:
          'wua1:' +
          Buffer.from(
            JSON.stringify({
              ...endpoint,
              token: grant.token,
              version: 1,
              channelId: grant.id,
              hostId,
              actorId,
              until: grant.until,
            }),
          ).toString('base64url'),
      };
    },
  });
  window.open();
  global.channelFixture = { channels, window };
});
