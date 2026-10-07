'use strict';
const { _electron } = require('playwright'),
  path = require('node:path'),
  fs = require('node:fs'),
  assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../artifacts/voice-runtime');
fs.mkdirSync(directory, { recursive: true });
(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'voice-runtime-fixture.cjs'), directory],
      env: { ...process.env, HYPHEN_VOICE_AUDIT: '1' },
      timeout: 30000,
    });
    const page = await app.firstWindow();
    await page.waitForSelector('h1');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    assert.equal(await page.evaluate(() => window.hyphenVoice !== undefined), true);
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('unavailable'),
    );
    assert.equal(await app.evaluate(() => global.voiceFixture.ledger.state.sessions.length), 0);
    await page.evaluate(() => {
      window.syntheticVoiceTracks = [];
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: async () => {
            const track = {
              label: 'Synthetic microphone',
              enabled: true,
              stopped: false,
              stop() {
                this.stopped = true;
              },
            };
            window.syntheticVoiceTracks.push(track);
            return { getTracks: () => [track], getAudioTracks: () => [track] };
          },
        },
      });
      window.RTCPeerConnection = class {
        addTrack() {}
        createDataChannel() {
          return { readyState: 'connecting', close() {}, send() {} };
        }
        async createOffer() {
          return { sdp: 'v=0\r\nsynthetic offer' };
        }
        async setLocalDescription() {}
        close() {
          this.connectionState = 'closed';
          this.onconnectionstatechange?.();
        }
      };
    });
    await page.getByLabel('Use my microphone for this session').check();
    await page.getByLabel('I accept separate API billing for this session').check();
    await page.waitForFunction(() => document.getElementById('context').options.length === 2);
    await page.getByLabel('Discuss a task').selectOption({ index: 1 });
    await page.waitForFunction(() =>
      document
        .getElementById('contextPreview')
        .textContent.includes('Synthetic bounded task status'),
    );
    assert.match(await page.locator('#contextWarning').textContent(), /Missing and truncated/);
    await page.screenshot({ path: path.join(directory, 'selected-context.png'), fullPage: true });
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('unavailable'),
    );
    assert.equal(await page.evaluate(() => window.syntheticVoiceTracks.length), 0);
    await page.getByLabel('Use my microphone for this session').check();
    await page.getByLabel('I accept separate API billing for this session').check();
    await page
      .getByLabel('Share this displayed task snapshot with the voice provider for this session')
      .check();
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    await page.waitForFunction(() => window.syntheticVoiceTracks.length === 1);
    await page.getByRole('button', { name: 'End voice', exact: true }).click();
    await page.waitForFunction(() => window.syntheticVoiceTracks[0].stopped === true);
    const result = await app.evaluate(() => ({
      status: global.voiceFixture.ledger.state.sessions.at(-1).status,
      live: !!global.voiceFixture.ledger.live,
    }));
    assert.equal(result.status, 'ended');
    assert.equal(result.live, false);
    assert.equal(
      await app.evaluate(
        () => global.voiceFixture.ledger.state.sessions.at(-1).selectedContext.coverage.fullHistory,
      ),
      false,
    );
    assert.equal(
      await page
        .getByLabel('Share this displayed task snapshot with the voice provider for this session')
        .isChecked(),
      false,
    );
    assert.equal(await page.getByLabel('Use my microphone for this session').isChecked(), false);
    await app.close();
    app = null;
    fs.writeFileSync(
      path.join(directory, 'verification.json'),
      JSON.stringify(
        {
          schema: 1,
          passed: true,
          accountsUsed: 0,
          modelCalls: 0,
          realAudioDevicesUsed: 0,
          installedAppChanged: false,
          evidence:
            'Sandboxed voice window; injected capture/peer; pending-handshake end stops owned tracks',
          ...result,
        },
        null,
        2,
      ),
    );
    console.log('Isolated voice UI lifecycle checks passed.');
  } finally {
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
