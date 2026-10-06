'use strict';
// Only the changed protocol variant is exercised. No physical UI input or foreground.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/dot-inbox/protocol-desktop-audit');
const bundle = path.join(root, 'artifacts/dot-inbox/desktop-protocol-build/win-unpacked');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(bundle, 'review-data'), { recursive: true });
process.env.TEMP = output;
process.env.TMP = output;
const { _electron: electron } = require('playwright');
const directory = fs.mkdtempSync(path.join(bundle, 'review-data/protocol-audit-'));
let app, page;
const checks = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push({ name, passed: true });
  process.stdout.write(name + '\n');
}
async function launch() {
  app = await electron.launch({
    executablePath: path.join(bundle, 'Work Updates Protocol Review.exe'),
    args: ['--audit-hidden', '--review-dir', directory],
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => model.snapshot?.transport?.kind === 'loopback-tls');
}
(async () => {
  try {
    await launch();
    const bootstrap = await page.evaluate(() => window.dotDesktop.bootstrap());
    check(
      'Packaged metadata selects the isolated protocol variant with its separate identity',
      bootstrap.appId === 'io.workupdates.desktop.review.protocol' &&
        bootstrap.appName === 'Work Updates Protocol Review',
    );
    const wire = await app.evaluate(() => {
      const a = globalThis.dotReviewAudit;
      return {
        peers: a.preview.snapshot().transport.peers,
        trace: a.preview.fixture.traceRows,
        state: a.controller.state(),
      };
    });
    check(
      'The changed desktop variant pairs two real loopback TLS peers while remaining hidden',
      wire.peers.every((p) => p.online) &&
        wire.trace.some((r) => r.type === 'tls.request' && r.tls?.startsWith('TLS')) &&
        !wire.state.visible &&
        !wire.state.focused,
    );
    const queued = await page.evaluate(() => {
      const card = model.items().find((c) => c.kind === 'local' && c.sources.length === 0);
      model.open(card);
      render();
      return {
        saved: model.persist(),
        storageError: model.storageError,
        readOnly: model.current().noConversation && !document.getElementById('reply'),
        warning: document.querySelector('.state-banner:not([hidden])')?.textContent,
      };
    });
    check(
      'A queued task without a conversation renders read-only and persists through the real desktop bridge',
      queued.saved &&
        !queued.storageError &&
        queued.readOnly &&
        queued.warning.includes('no source conversation'),
    );
    const reply = await page.evaluate(async () => {
      const card = model.items().find((c) => c.kind !== 'local');
      model.open(card, card.primarySourceId);
      model.draft('Native protocol fixture reply.');
      const intent = model.begin(model.token(), 'reply', crypto.randomUUID());
      const out = await request('/api/action', intent);
      model.update(out.snapshot);
      model.draft('Draft preserved after verified TLS acceptance.');
      return {
        accepted: out.result.ownerAccepted,
        ownerId: card.owner.id,
        eventId: intent.eventId,
      };
    });
    const executed = await app.evaluate(() => {
      const f = globalThis.dotReviewAudit.preview.fixture;
      return { commands: f.commands, trace: f.traceRows, cards: f.snapshot().cards };
    });
    check(
      'Normal desktop protocol API reaches the exact synthetic owner and displays its TLS-snapshot context',
      reply.accepted &&
        executed.commands.length === 1 &&
        executed.commands[0].ownerId === reply.ownerId &&
        executed.cards.some((c) =>
          c.sources.some((s) =>
            s.messages?.some((m) => m.text === 'Native protocol fixture reply.'),
          ),
        ),
    );
    await app.close();
    app = null;
    await launch();
    const recovered = await page.evaluate(() => ({
      draft: model.draft(),
      intents: model.export().intents,
      commands: model.snapshot.preview.commands.length,
    }));
    check(
      'Protocol variant restart restores the durable draft and accepted receipt without redelivery',
      recovered.draft === 'Draft preserved after verified TLS acceptance.' &&
        recovered.intents.some(([, i]) => i.eventId === reply.eventId && i.ownerAccepted) &&
        recovered.commands === 1,
    );
    const trace = await app.evaluate(() => globalThis.dotReviewAudit.preview.fixture.traceFile);
    fs.copyFileSync(trace, path.join(output, 'transport-trace.jsonl'));
    const preferences = await app.evaluate(() =>
      globalThis.dotReviewAudit.window.webContents.getLastWebPreferences(),
    );
    check(
      'The protocol variant retains renderer sandbox and context isolation',
      preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration,
    );
    await app.close();
    app = null;
    fs.writeFileSync(
      path.join(output, 'checks.json'),
      JSON.stringify(
        {
          checks,
          directory,
          nativeInput:
            'No physical click/keyboard/drag/focus attempted; shared desktop ownership remains deferred.',
        },
        null,
        2,
      ),
    );
    process.stdout.write(checks.length + ' changed-variant transport/IPC/restart checks passed.\n');
  } catch (error) {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
