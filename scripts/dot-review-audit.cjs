'use strict';
// Source/IPC audit only. No OS input, click synthesis, activation or native drag.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const bundle = path.join(root, 'artifacts', 'dot-inbox', 'desktop-build', 'win-unpacked');
const output = path.join(
  root,
  'artifacts',
  'dot-inbox',
  packaged ? 'desktop-packaged-audit' : 'desktop-audit',
);
const allowed = packaged
  ? path.join(bundle, 'review-data')
  : path.join(root, 'artifacts', 'dot-inbox', 'desktop-review');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(allowed, { recursive: true });
process.env.TEMP = output;
process.env.TMP = output;
const { _electron: electron } = require('playwright');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const { InboxModel } = require('../candidate/dot-inbox/model.js');
const data = fs.mkdtempSync(path.join(allowed, 'audit-'));
const checks = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push({ name, passed: true });
  process.stdout.write(name + '\n');
}
let app, page, firstPort, imported, expectedSeed, expectedCommands, seedDirectory;
let captureUnavailable = '';
async function recoverySeed() {
  seedDirectory = path.join(root, 'artifacts/dot-inbox/preserved-browser');
  if (
    !fs.existsSync(path.join(seedDirectory, 'client-recovery.json')) ||
    !fs.existsSync(path.join(seedDirectory, 'recovery.json'))
  ) {
    seedDirectory = path.join(output, 'generated-seed');
    const fixture = await startPreview({
      recoveryRoot: seedDirectory,
      sessionsRoot: path.join(output, 'seed-sessions'),
    });
    fixture.choose('active');
    const model = new InboxModel();
    model.update(fixture.snapshot());
    for (const card of model.items()) {
      model.open(card, card.primarySourceId);
      model.draft('Separate synthetic draft for ' + card.id);
    }
    const pc = model.items().find((c) => c.owner.id.endsWith('0001') && c.id === 'sample-project');
    model.open(pc, pc.sources[1].id);
    model.draft('Separate secondary source draft.');
    model.open(pc, pc.primarySourceId);
    model.draft('Keep the compact layout and update the spacing.');
    fs.writeFileSync(
      path.join(seedDirectory, 'client-recovery.json'),
      JSON.stringify(model.export()),
    );
    await fixture.close();
  }
  expectedSeed = JSON.parse(
    fs.readFileSync(path.join(seedDirectory, 'client-recovery.json'), 'utf8'),
  );
  const journal = JSON.parse(fs.readFileSync(path.join(seedDirectory, 'recovery.json'), 'utf8'));
  expectedCommands = journal.fixture?.commands?.length || 0;
}
async function launch() {
  app = await electron.launch({
    ...(packaged ? { executablePath: path.join(bundle, 'Work Updates Review.exe') } : {}),
    args: [
      ...(!packaged ? [path.join(root, 'candidate/dot-inbox/desktop/main.cjs')] : []),
      '--audit-hidden',
      '--review-dir',
      data,
      '--seed-from',
      seedDirectory,
    ],
    timeout: 30000,
  });
  page = await app.firstWindow({ timeout: 30000 });
  await page.waitForFunction(
    () => typeof model !== 'undefined' && model.snapshot?.cards.length > 0,
  );
}
async function main(fn, input) {
  return app.evaluate(fn, input);
}
async function capture(name) {
  if (captureUnavailable) return;
  try {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const png = await main(async () =>
      (
        await globalThis.dotReviewAudit.window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64'),
    );
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(png, 'base64'));
  } catch (error) {
    captureUnavailable = 'Hidden capture unavailable: ' + error.message;
    process.stdout.write(
      captureUnavailable + '. Continue IPC/recovery checks without presenting the window.\n',
    );
  }
}
(async () => {
  try {
    await recoverySeed();
    await launch();
    const initial = await main(({ app, BrowserWindow }) => {
      const a = globalThis.dotReviewAudit;
      return {
        appName: app.getName(),
        userData: app.getPath('userData'),
        appId: a.appId,
        state: a.controller.state(),
        origin: a.preview.origin,
        windows: BrowserWindow.getAllWindows().length,
      };
    });
    firstPort = initial.origin;
    check(
      'Owned Electron window uses separate identity, profile and private data',
      initial.appName === 'Work Updates Review' &&
        initial.appId === 'io.workupdates.desktop.review' &&
        initial.userData.startsWith(data + path.sep) &&
        initial.windows === 1,
    );
    check(
      'Startup remains a hidden, unfocused 76px quiet dot',
      !initial.state.visible &&
        !initial.state.focused &&
        !initial.state.expanded &&
        initial.state.bounds.width === 76 &&
        initial.state.focusRequests === 0,
    );
    const state = await page.evaluate(() => ({
      opened: model.opened,
      view: model.view,
      drafts: model.export().drafts,
      intents: model.export().intents,
      commands: model.snapshot.preview.commands.length,
      readOnly: model.snapshot.preview.liveEnabled,
      selection: model.export().selection,
      host: location.host,
      bridge: Object.keys(window.dotDesktop),
      node: typeof window.require,
    }));
    imported = state;
    check(
      'Preserved drafts and receipts restore on a stable private origin without dispatch',
      state.drafts.length === expectedSeed.drafts.length &&
        state.intents.length === expectedSeed.intents.length &&
        state.selection.ownerId.endsWith('0001') &&
        !state.opened &&
        state.host === 'app' &&
        !state.readOnly &&
        state.commands === expectedCommands,
    );
    check(
      'Sandbox exposes only fixed desktop/recovery bridge, no Node or production command API',
      state.node === 'undefined' &&
        !state.bridge.includes('send') &&
        !state.bridge.includes('controller'),
    );
    await capture('quiet-dot');
    await main(() => globalThis.dotReviewAudit.window.webContents.send('dot-review:tools'));
    await page.waitForFunction(
      () => document.body.classList.contains('review-tools') && model.opened,
    );
    check(
      'Review tools event opens the inbox consistently without requesting audit focus',
      await main(() => globalThis.dotReviewAudit.controller.state().focusRequests === 0),
    );
    await main(() => globalThis.dotReviewAudit.window.webContents.send('dot-review:tools'));
    const expanded = await page.evaluate(() => window.dotDesktop.setExpanded(true, true));
    check(
      'Real window IPC expands within monitor bounds while hidden audit forbids focus',
      expanded.expanded &&
        expanded.bounds.width > 400 &&
        !expanded.visible &&
        !expanded.focused &&
        expanded.focusRequests === 0,
    );
    const rejected = await page.evaluate(async () => {
      try {
        await window.dotDesktop.setExpanded('open', true);
        return false;
      } catch {
        return true;
      }
    });
    check('Invalid desktop IPC window intent is rejected', rejected);
    // Drive model methods directly as an integration check, not a physical UI test.
    await page.evaluate(() => {
      model.opened = true;
      model.navigate('inbox');
      render();
    });
    await capture('inbox');
    const source = await page.evaluate(() => {
      const card = model
        .items()
        .find((c) => c.owner.id.endsWith('0001') && c.id === 'sample-project');
      model.open(card, card.primarySourceId);
      render();
      return {
        name:
          document.querySelector('.conversation-heading')?.textContent ||
          document.querySelector('h1')?.textContent,
        text: model.draft(),
        current: model.current().item.owner.id,
      };
    });
    check(
      'Current exact PC conversation restores its own draft',
      source.text === 'Keep the compact layout and update the spacing.' &&
        source.current.endsWith('0001'),
    );
    await capture('conversation');
    await page.evaluate(() => {
      model.navigate('queue');
      render();
    });
    await capture('queue');
    await page.evaluate(() => {
      model.navigate('relationships');
      render();
    });
    await capture('relationships');
    const preferences = await main(() =>
      globalThis.dotReviewAudit.window.webContents.getLastWebPreferences(),
    );
    check(
      'Owned renderer retains sandbox, context isolation and disabled Node integration',
      preferences.sandbox &&
        preferences.contextIsolation &&
        !preferences.nodeIntegration &&
        !preferences.nodeIntegrationInSubFrames,
    );
    const routes = await page.evaluate(async () => {
      const blocked = await fetch('/main.cjs');
      const noHeader = await fetch('/api/action', { method: 'POST', body: '{}' });
      return [blocked.status, noHeader.status];
    });
    check(
      'Desktop protocol blocks filesystem paths and unmarked actions',
      routes.every((s) => s === 403),
    );
    await main(() => {
      const a = globalThis.dotReviewAudit;
      const b = a.window.getBounds();
      a.window.setBounds({ ...b, x: b.x + 30, y: b.y + 10 });
      a.controller.remember();
    });
    const placement = await main(() => globalThis.dotReviewAudit.controller.state().bounds);
    check(
      'Placement is journaled by the native window coordinator',
      JSON.parse(fs.readFileSync(path.join(data, 'placement.json'), 'utf8')).panel.x ===
        placement.x,
    );
    const latest = await main(() => {
      const a = globalThis.dotReviewAudit;
      a.preview.choose('active');
      return a.preview.snapshot();
    });
    await page.evaluate((snapshot) => {
      model.update(snapshot, { reconnect: true });
      const card = model
        .items()
        .find((c) => c.owner.id.endsWith('0001') && c.id === 'sample-project');
      model.open(card, card.primarySourceId);
      model.draft('Late response must stay with this exact PC source.');
    }, latest);
    const token = await page.evaluate(() => {
      const token = model.token();
      model.begin(token, 'reply', crypto.randomUUID());
      return [...model.intents.values()].at(-1);
    });
    const newerDraft = 'New edit after owner acceptance; retain it.';
    // Acceptance belongs to PC, while user selection/draft switches to Mac.
    await page.evaluate((text) => {
      model.draft(text);
      const mac = model.items().find((c) => c.owner.id.endsWith('0003'));
      model.open(mac, mac.primarySourceId);
      model.draft('Different computer draft.');
    }, newerDraft);
    const accepted = await page.evaluate(async (token) => {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dot-Preview': 'fixture' },
        body: JSON.stringify(token),
      });
      if (!response.ok) throw new Error('Bound desktop fixture action rejected.');
      return response.json();
    }, token);
    accepted.commands = await main(() => globalThis.dotReviewAudit.preview.fixture.commands);
    await page.evaluate((snapshot) => {
      model.update(snapshot, { reconnect: true });
    }, accepted.snapshot);
    const afterLate = await page.evaluate(() => ({
      text: model.draft(),
      owner: model.selection.item.owner.id,
      drafts: model.export().drafts,
      intents: model.export().intents,
    }));
    check(
      'Late acceptance retains a new PC edit and the selected Mac draft',
      accepted.result.ownerAccepted &&
        afterLate.text === 'Different computer draft.' &&
        afterLate.owner.endsWith('0003') &&
        afterLate.drafts.some(([, text]) => text === newerDraft),
    );
    check(
      'Desktop protocol accepts a marked fixture reply exactly once on its bound synthetic owner',
      accepted.commands.length === imported.commands + 1 &&
        accepted.commands.at(-1).ownerId.endsWith('0001'),
    );
    const repeat = await main(async (_, token) => {
      const a = globalThis.dotReviewAudit;
      await a.preview.act(token);
      return a.preview.fixture.commands.length;
    }, token);
    check(
      'Repeating the accepted event does not dispatch a second owner command',
      repeat === accepted.commands.length,
    );
    await page.reload();
    await page.waitForFunction(() => model.snapshot?.cards.length > 0);
    const reload = await page.evaluate(() => ({
      text: model.draft(),
      opened: model.opened,
      intents: model.export().intents,
      drafts: model.export().drafts,
    }));
    check(
      'Full renderer reload retains new drafts and accepted receipt while staying quiet',
      !reload.opened &&
        reload.text === afterLate.text &&
        reload.drafts.some(([, text]) => text === newerDraft) &&
        reload.intents.some(([, i]) => i.eventId === token.eventId && i.ownerAccepted),
    );
    const beforeClose = fs.readFileSync(path.join(data, 'client-recovery.json'), 'utf8');
    await main(() => globalThis.dotReviewAudit.window.close());
    check(
      'Native close collapses the owned window without quitting or opening it',
      await main(
        () =>
          !globalThis.dotReviewAudit.controller.expanded &&
          !globalThis.dotReviewAudit.window.isDestroyed() &&
          !globalThis.dotReviewAudit.window.isVisible(),
      ),
    );
    await app.close();
    app = null;
    await launch();
    const restarted = await main(() => {
      const a = globalThis.dotReviewAudit;
      return {
        origin: a.preview.origin,
        commands: a.preview.fixture.commands.length,
        state: a.controller.state(),
      };
    });
    const recovered = await page.evaluate(() => ({
      text: model.draft(),
      intents: model.export().intents,
      drafts: model.export().drafts,
      error: model.storageError,
    }));
    check(
      'Full isolated process restart changes loopback port but preserves stable recovery origin',
      restarted.origin !== firstPort && (await page.url()).startsWith('work-updates-review://app/'),
    );
    check(
      'Restart restores exact drafts and accepted receipt without automatic resend',
      !recovered.error &&
        recovered.text === afterLate.text &&
        recovered.drafts.some(([, text]) => text === newerDraft) &&
        recovered.intents.some(([, i]) => i.eventId === token.eventId && i.ownerAccepted) &&
        restarted.commands === accepted.commands.length,
    );
    check(
      'Restart restores compact placement and remains hidden/unfocused',
      restarted.state.bounds.width === 76 &&
        !restarted.state.visible &&
        !restarted.state.focused &&
        restarted.state.focusRequests === 0,
    );
    check(
      'Original browser recovery copy remains unchanged by desktop actions',
      JSON.parse(fs.readFileSync(path.join(seedDirectory, 'client-recovery.json'), 'utf8')).drafts
        .length === imported.drafts.length,
    );
    check(
      'Durable renderer recovery contains no incoming source logs or snapshots',
      !beforeClose.includes('sources') &&
        !beforeClose.includes('snapshot') &&
        !beforeClose.includes('sourcesBody'),
    );
    const errors = await page.evaluate(() => model.storageError || model.error);
    check('Recovered model reports no storage or connection error', !errors);
    await app.close();
    app = null;
    fs.writeFileSync(
      path.join(output, 'checks.json'),
      JSON.stringify(
        {
          checks,
          captureUnavailable,
          dataDirectory: data,
          nativeInput:
            'Deferred: shared Windows input is owned by Studio sessions. No physical clicks, typing, drag or foreground test was attempted.',
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      checks.length +
        ' hidden desktop source/IPC/restart checks passed. Physical native controls remain unverified.\n',
    );
  } catch (error) {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
