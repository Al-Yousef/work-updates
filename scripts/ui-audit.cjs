'use strict';
const { _electron: electron } = require('playwright');
const {closeAuditApp,forceAuditApp}=require('./electron-audit-lifecycle.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-ui-')),
  output = path.join(root, 'artifacts', 'ui');
fs.mkdirSync(output, { recursive: true });
let app;
let checks = 0;
let lastCheck = 'launch';
// Unsigned macOS audit builds must not wait for a real Keychain permission
// dialog. Match Electron's own synthetic-test setup; production is unchanged.
const auditFlags = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
const deadline = setTimeout(() => {
  process.stderr.write('Synthetic UI audit timed out after: ' + lastCheck + '\n');
  process.exitCode = 1;
  forceAuditApp(app);
}, 150000);
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
  lastCheck = message;
};
async function waitFor(page, fn) {
  try{await page.waitForFunction(fn, null, { timeout: 12000 });}
  catch(error){console.error('Synthetic UI assertion state:',await page.evaluate(()=>({status:document.querySelector('#panel-status')?.textContent,userMessages:document.querySelectorAll('.message.user').length,taskError:document.querySelector('#task-error')?.textContent,notice:document.querySelector('#notice')?.textContent,draftLength:document.querySelector('#chat-input')?.value.length})));throw error;}
}
(async () => {
  try {
    const executablePath = process.env.WORK_UPDATES_EXECUTABLE;
    app = await electron.launch({
      executablePath,
      args: [...(!executablePath ? [root] : []), ...auditFlags, '--demo', '--hidden', '--data-dir', dir],
      timeout: 30000,
    });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.locator('.card-trigger').first().waitFor({ state: 'attached' });
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'hidden',
      'Background launch conceals the queue with the weather shortcut disabled',
    );
    await page.waitForTimeout(300);
    check(
      await page
        .locator('html')
        .evaluate((e) => Number(getComputedStyle(e).opacity) === 0 && document.body.inert),
      'Concealed startup paints no queue and cannot accept input',
    );
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json')));
    check(
      fs.existsSync(runtime.diagnostics.file) &&
        fs.readFileSync(runtime.diagnostics.file, 'utf8').includes('app.started'),
      'Native app writes its private startup diagnostic log',
    );
    check(
      runtime.tray.registered && !runtime.visible,
      'Native tray registers while the queue remains hidden',
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const focusable = window.setFocusable.bind(window),
        skip = window.setSkipTaskbar.bind(window);
      globalThis.auditTrayFocus = [];
      window.setFocusable = (value) => {
        globalThis.auditTrayFocus.push(['focusable', value]);
        focusable(value);
      };
      window.setSkipTaskbar = (value) => {
        globalThis.auditTrayFocus.push(['skipTaskbar', value]);
        skip(value);
      };
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    check(
      (await app.windows()).length === 1,
      'Native close conceals the queue without terminating the tray app',
    );
    await page.evaluate(() => window.workUpdates.window({ action: 'show' }));
    await page.waitForFunction(
      () => Number(getComputedStyle(document.documentElement).opacity) === 1,
    );
    check(
      await app.evaluate(
        () =>
          JSON.stringify(globalThis.auditTrayFocus.slice(-2)) ===
          JSON.stringify([
            ['focusable', true],
            ['skipTaskbar', true],
          ]),
      ),
      'Taking keyboard focus reapplies native taskbar exclusion',
    );
    const focusChanges = await app.evaluate(() => globalThis.auditTrayFocus.length);
    await page.evaluate(() => window.workUpdates.window({ action: 'show' }));
    check(
      (await app.evaluate(() => globalThis.auditTrayFocus.length)) === focusChanges,
      'Repeated opens preserve focus and do not recreate the taskbar entry',
    );
    const nativeHit = async (selector) => {
      const bounds = await page.locator(selector).boundingBox();
      const target = await app.evaluate(
        ({ BrowserWindow, screen }, point) => {
          const w = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().endsWith('/index.html'),
          );
          const origin = w.getBounds(),
            handle = w.getNativeWindowHandle();
          return {
            point: screen.dipToScreenPoint({ x: origin.x + point.x, y: origin.y + point.y }),
            handle: (handle.length === 8
              ? handle.readBigUInt64LE()
              : BigInt(handle.readUInt32LE())
            ).toString(),
          };
        },
        { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
      );
      return Number(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(root, 'tests', 'native-control-hit.ps1'),
            '-X',
            String(target.point.x),
            '-Y',
            String(target.point.y),
            '-Handle',
            target.handle,
          ],
          { windowsHide: true, encoding: 'utf8', timeout: 30000 },
        ).trim(),
      );
    };
    const chooseView = async (view) => {
      await page.getByRole('button', { name: 'Choose task view', exact: true }).click();
      await page.locator('[data-view=' + view + ']').click();
    };
    const nativeScreenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      await page.locator('#notice').waitFor({ state: 'hidden', timeout: 6000 });
      await page.waitForFunction(() => document.documentElement.getAnimations().length === 0);
      await page.waitForTimeout(200);
      return nativeScreenshot(options);
    };
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.card-trigger').first().waitFor();
    check((await page.locator('.card-trigger').count()) === 3, 'Synthetic queue loads');
    check((await page.locator('.tabs').count()) === 0, 'Lock-screen surface has no tab bar');
    check(
      (await page.locator('.card-trigger').first().getAttribute('aria-label')).includes(
        'Waiting on you',
      ),
      'Waiting on you appears first',
    );
    check(
      (await page.locator('.card-trigger').nth(1).locator('.urgent').count()) === 1,
      'Urgent task follows waiting on you',
    );
    check(
      (await page.locator('.card-trigger').nth(2).innerText()).includes('Waiting on reviewer'),
      'External wait identifies the owner',
    );
    check(
      (await page.evaluate(() => typeof require)) === 'undefined',
      'Renderer has no Node access',
    );
    await waitFor(page, () =>
      [...document.querySelectorAll('.app-icon')].every((e) => e.complete && e.naturalWidth > 0),
    );
    check(true, 'Notification icons load under the app content policy');
    check(
      (await page.locator('.card-trigger').first().locator('.meta').innerText()) ===
        'Interface review' &&
        (await page.locator('.card-trigger').first().locator('.card-summary').innerText()).includes(
          'Both previews are ready',
        ),
      'A card shows its actual chat name and a recorded update alongside the task and status',
    );
    check(
      await page.locator('.swipe-actions').first().isHidden(),
      'Swipe commands stay hidden until a swipe',
    );
    await page.screenshot({ path: path.join(output, 'queue.png') });
    await page
      .locator('#queue')
      .screenshot({ path: path.join(output, 'chat-summary-preview.png') });
    const swipeCard = page.getByRole('button', { name: 'Review launch notes, Ready to review' });
    const swipeBounds = await swipeCard.boundingBox();
    await page.mouse.move(swipeBounds.x + swipeBounds.width - 25, swipeBounds.y + 45);
    await page.mouse.down();
    await page.mouse.move(swipeBounds.x + 70, swipeBounds.y + 45, { steps: 8 });
    await page.mouse.up();
    await page.locator('.swiped .swipe-actions').waitFor({ state: 'visible' });
    check(await page.locator('#scrim').isHidden(), 'Swipe reveals options without opening a panel');
    await page.screenshot({ path: path.join(output, 'swipe.png') });
    await page.locator('.swiped').getByRole('button', { name: 'Snooze 1h', exact: true }).click();
    await waitFor(page, () => document.querySelectorAll('.card-trigger').length === 2);
    check(true, 'Swipe snooze postpones only the chosen notification');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitFor(page, () => document.querySelectorAll('.card-trigger').length === 3);
    await page.getByRole('button', { name: 'Review launch notes, Ready to review' }).click();
    check(
      (await page.getByRole('button', { name: 'Open chat ↗', exact: true }).count()) === 1,
      'Click includes quick actions with full task information',
    );
    check(
      (await page.locator('#chat-input').count()) === 1 &&
        (await page.locator('#context-host').count()) === 1,
      'Normal click opens details and conversation without a hold',
    );
    await page.screenshot({ path: path.join(output, 'actions.png') });
    const close = page.getByRole('button', { name: 'Back to queue', exact: true });
    const closeBounds = await close.boundingBox();
    check(closeBounds.width >= 44 && closeBounds.height >= 44, 'Panel X has a 44px click target');
    if (process.platform === 'win32')
      check(
        (await nativeHit('.panel-top button')) === 1,
        'Windows treats panel X as a button, not a caption drag',
      );
    await close.click();
    check(await page.locator('#scrim').isHidden(), 'Clicking panel X returns to queue');
    await page.getByRole('button', { name: 'Review launch notes, Ready to review' }).focus();
    await page.keyboard.press('Enter');
    check(
      (await page.locator('#chat-input').count()) === 1,
      'Enter opens the full task information',
    );
    check(
      (await page.locator('#complete-task').count()) === 1 &&
        !(await page.locator('#complete-task').isVisible()),
      'Completion is tucked into Task settings',
    );
    check(
      (await page.getByRole('button', { name: 'Reviewed', exact: true }).count()) === 1,
      'Notification has one Reviewed action without a duplicate tick',
    );
    await page.locator('.task-options summary').click();
    await page.getByRole('button', { name: 'Complete task', exact: true }).click();
    await waitFor(page, () => document.querySelector('#scrim').hidden);
    check((await page.locator('.card-trigger').count()) === 2, 'Done removes update');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitFor(page, () => document.querySelectorAll('.card-trigger').length === 3);
    check(true, 'Undo restores task');
    const launch = page.getByRole('button', { name: 'Review launch notes, Ready to review' });
    await launch.click({ button: 'right' });
    check((await page.locator('#chat-input').count()) === 1, 'Right click opens conversation');
    await page.keyboard.press('Escape');
    await launch.focus();
    await page.keyboard.press('Shift+F10');
    check((await page.locator('#chat-input').count()) === 1, 'Keyboard contextual route');
    await page.keyboard.press('Escape');
    check(await launch.evaluate((e) => e === document.activeElement), 'Focus returns to card');
    const bounds = await launch.boundingBox();
    await page.mouse.move(bounds.x + 80, bounds.y + 45);
    await page.mouse.down();
    await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 5000 });
    await page.mouse.up();
    check(
      (await page.locator('#chat-input').count()) === 1,
      'Hold opens conversation exactly once',
    );
    await page.screenshot({ path: path.join(output, 'chat.png') });
    check(
      await page.locator('.task-options').evaluate((e) => !e.open),
      'Hold keeps task settings collapsed',
    );
    await page.locator('.task-options summary').focus();
    await page.keyboard.press('Tab');
    check(
      await page
        .getByRole('button', { name: 'Back to queue', exact: true })
        .evaluate((e) => e === document.activeElement),
      'Tab wraps past collapsed task settings',
    );
    await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
    check(
      await launch.evaluate((e) => e === document.activeElement),
      'Hold dismissal returns focus to its notification',
    );
    await page.mouse.move(bounds.x + 80, bounds.y + 45);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 105, bounds.y + 45);
    await page.waitForTimeout(750);
    await page.mouse.up();
    check(await page.locator('#scrim').isHidden(), 'Dragging cancels hold and click');
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    await page.locator('#task-title').fill('Check the compact task queue');
    await page.locator('#task-prompt').fill('Verify a sample task without changing files.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    check(
      (await page.locator('#task-title').inputValue()) === 'Check the compact task queue',
      'Composer draft survives cancel',
    );
    await page.screenshot({ path: path.join(output, 'composer.png') });
    await page.getByRole('button', { name: 'Queue task', exact: true }).click();
    await chooseView('queued');
    await page.locator('.card-trigger').first().click();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await waitFor(page, () =>
      document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    check(true, 'Queued task starts a dedicated demo chat');
    await page.locator('#chat-input').fill('Confirm the follow-up message.');
    await page.locator('#chat-input').press('Shift+Enter');
    check(
      (await page.locator('#chat-input').inputValue()).endsWith('\n'),
      'Shift+Enter adds a line',
    );
    await page.locator('#chat-input').evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    check(
      (await page.locator('.message.user').count()) === 1,
      'IME composition does not send a message',
    );
    await page.locator('#chat-input').press('Enter');
    await page.locator('#chat-input').press('Enter');
    await waitFor(
      page,
      () =>
        document.querySelectorAll('.message.user').length === 2 &&
        document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    check(true, 'Enter sends exactly one follow-up and receives completion');
    await page.keyboard.press('Escape');
    await chooseView('updates');
    await page
      .getByRole('button', { name: 'Check the compact task queue, Ready to review' })
      .click();
    await page.locator('.task-options summary').click();
    await page.getByRole('button', { name: 'Complete task', exact: true }).click();
    await chooseView('done');
    await page.locator('.card-trigger').first().click();
    await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
    check(true, 'Done list reopens local task');
    await chooseView('updates');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 590));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(output, 'compact.png') });
    check(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      'Compact window avoids horizontal overflow',
    );
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    await page.evaluate(() => (document.body.style.zoom = '1.25'));
    await page.screenshot({ path: path.join(output, 'composer-zoom.png') });
    check(
      await page.locator('#queue-task').isVisible(),
      'Composer primary remains reachable at zoom',
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.body.style.zoom = '1'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(484, 720));
    await page
      .getByRole('button', { name: 'Review launch notes, Ready to review' })
      .click({ button: 'right' });
    await page.locator('.task-options summary').click();
    await page.locator('#manual-status').selectOption('waiting');
    await waitFor(page, () =>
      document.querySelector('#panel-status').textContent.includes('Waiting'),
    );
    check(
      (await page.locator('#chat-input').count()) === 1,
      'Manual status keeps the conversation open',
    );
    await page.locator('#waiting-owner').fill('Design team');
    await page.getByRole('button', { name: 'Set', exact: true }).click();
    await waitFor(page, () =>
      document.querySelector('#panel-status').textContent.includes('Waiting on Design team'),
    );
    check(true, 'Waiting owner is displayed after saving');
    await page.locator('#task-priority').selectOption('urgent');
    check(
      (await page.locator('#chat-input').count()) === 1,
      'Priority editing preserves mini chat',
    );
    await page.locator('#manual-status').selectOption('auto');
    await waitFor(page, () =>
      document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Manage chat groups', exact: true }).click();
    await page.getByRole('button', { name: 'Create a group', exact: true }).click();
    await page.locator('#group-title').fill('Launch review');
    await page.getByLabel('Launch planning', { exact: true }).check();
    await page.getByLabel('Interface review', { exact: true }).check();
    await page.getByRole('button', { name: 'Save group', exact: true }).click();
    await page.locator('.grouped').waitFor();
    check(true, 'Grouping produces a connected notification stack');
    await page.locator('.grouped .card-trigger').click();
    const groupSource = page.locator('#source-chat');
    const attentionSource = '10000000-0000-4000-8000-000000000003';
    check(
      (await groupSource.inputValue()) === attentionSource,
      'Group defaults to the source behind its visible task',
    );
    check(
      (await page.locator('#context-host .source-name').count()) === 1 &&
        (await page.locator('#context-host').innerText()).includes('Interface review'),
      'Details shows only the selected source context',
    );
    const selectedRoute = await page.evaluate(async (sourceId) => {
      const state = (await window.workUpdates.state()).value,
        card = state.cards.find((c) => c.sources.length > 1);
      return (await window.workUpdates.open({ id: card.id, taskKey: card.taskKey, sourceId }))
        .value;
    }, attentionSource);
    check(
      selectedRoute.sourceId === attentionSource,
      'Open chat routes to the displayed source id',
    );
    const launchSource = '10000000-0000-4000-8000-000000000001';
    await groupSource.selectOption(launchSource);
    check(
      (await page.locator('.panel-title').innerText()) === 'Review launch notes',
      'Switching source switches the task information',
    );
    check(
      (await page.locator('#notification-chat-name').innerText()) === 'Launch planning',
      'Source selection updates the expanded chat name',
    );
    await page.locator('#chat-input').fill('Keep this draft in launch planning.');
    await groupSource.selectOption(attentionSource);
    check(
      (await page.locator('#chat-input').inputValue()) === '',
      'Reply drafts do not leak between grouped chats',
    );
    await groupSource.selectOption(launchSource);
    check(
      (await page.locator('#chat-input').inputValue()).includes('launch planning'),
      'Switching back restores only that chat draft',
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Manage chat groups', exact: true }).click();
    await page.getByRole('button', { name: 'Launch review · 2 chats', exact: true }).click();
    await page.getByRole('button', { name: 'Ungroup these chats', exact: true }).click();
    check(
      (await page.locator('.grouped').count()) === 0,
      'Ungroup restores independent source cards',
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.locator('.grouped').waitFor();
    check(true, 'Undo restores only the grouping');
    await page.locator('#notice').waitFor({ state: 'hidden', timeout: 6000 });
    const baseline = await page.evaluate(async () => (await window.workUpdates.state()).value);
    // This section tests renderer projections from explicit snapshots. Keep
    // periodic demo publications from replacing a fixture between assertions.
    // Restore the real transport before the following interaction checks.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const original = contents.send;
      globalThis.auditFixtureStateTransport = { contents, original };
      contents.send = function(channel, ...values) {
        if (channel !== 'work-updates:state') return original.call(this, channel, ...values);
      };
    });
    const pushFixture = async (fixture) =>
      app.evaluate((_, value) => {
        const { contents, original } = globalThis.auditFixtureStateTransport;
        original.call(contents, 'work-updates:state', value);
      }, fixture);
    const metadataFixture = structuredClone(baseline);
    metadataFixture.cards = [metadataFixture.cards[0]];
    metadataFixture.cards[0].chatName = 'Build review';
    metadataFixture.cards[0].summary = 'The new build passed. Waiting for the installer review.';
    metadataFixture.cards[0].device = { kind: 'mac' };
    const metadataSource = metadataFixture.cards[0].sources.find(
      (s) => s.id === metadataFixture.cards[0].primarySourceId,
    );
    metadataSource.title = 'Build review';
    metadataSource.device = { kind: 'mac' };
    await pushFixture(metadataFixture);
    await page
      .getByText('The new build passed. Waiting for the installer review.', { exact: true })
      .waitFor();
    check(
      (await page.locator('.meta').innerText()).startsWith('Build review') &&
        (await page.locator('#queue .status-indicator').getAttribute('data-device')) === 'mac',
      'Updated summary, chat name and source device render together',
    );
    await page.locator('.card-trigger').click();
    check(
      (await page.locator('#notification-chat-name').innerText()) === 'Build review' &&
        (await page.locator('#panel .status-indicator').getAttribute('data-device')) === 'mac',
      'Expanded notification preserves the selected source device',
    );
    await page.keyboard.press('Escape');
    metadataFixture.cards[0].device = { kind: 'phone' };
    await pushFixture(metadataFixture);
    await page.locator('#queue .status-indicator[data-device=phone]').waitFor();
    check(
      (await page.locator('.card-trigger').getAttribute('aria-description')).includes('Phone'),
      'An explicitly recorded phone remains a phone on a desktop viewer',
    );
    delete metadataFixture.cards[0].device;
    await pushFixture(metadataFixture);
    await page.locator('#queue .status-indicator[data-device=unknown]').waitFor();
    check(
      (await page.locator('#queue .status-indicator').getAttribute('title')) ===
        'Device not recorded',
      'An unknown origin is not guessed from the viewer platform',
    );
    await pushFixture(baseline);
    const statusFixture = (status, label, owner = 'none') => {
      const fixture = structuredClone(baseline);
      fixture.cards = [
        {
          ...fixture.cards[0],
          status,
          label,
          done: false,
          waitingOn: { kind: owner },
          urgent: false,
        },
      ];
      return fixture;
    };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await pushFixture(statusFixture('working', 'Working'));
    await page.locator('#queue .status-indicator[data-status=working]').waitFor();
    const ringBefore = await page
      .locator('#queue .status-indicator')
      .evaluate((e) => getComputedStyle(e, '::after').transform);
    await page.waitForTimeout(180);
    check(
      await page
        .locator('#queue .status-indicator')
        .evaluate(
          (e, before) =>
            getComputedStyle(e, '::after').animationName === 'status-turn' &&
            getComputedStyle(e, '::after').transform !== before,
          ringBefore,
        ),
      'The working ring actually rotates around the stationary device',
    );
    await page.locator('.card-trigger').click();
    await page.locator('#panel .status-indicator[data-status=working]').waitFor();
    await page.evaluate(() => {
      window.auditStatusIcon = document.querySelector('#panel .status-indicator');
    });
    await pushFixture(statusFixture('ready', 'Ready to review'));
    await page.locator('#panel .status-indicator[data-status=ready]').waitFor();
    check(
      await page.evaluate(
        () =>
          document.querySelector('#panel .status-indicator') === window.auditStatusIcon &&
          getComputedStyle(window.auditStatusIcon, '::after').animationName === 'none',
      ),
      'A live completion updates the same expanded device and stops its ring',
    );
    await page.keyboard.press('Escape');
    const statusCues = [];
    for (const [status, label, owner] of [
      ['needs', 'Waiting on you', 'you'],
      ['blocked', 'Blocked', 'none'],
      ['ready', 'Ready to review', 'none'],
      ['waiting', 'Waiting on reviewer', 'other'],
      ['unknown', 'Check status', 'unknown'],
    ]) {
      await pushFixture(statusFixture(status, label, owner));
      await page.locator('#queue .status-indicator[data-status=' + status + ']').waitFor();
      statusCues.push(
        await page.locator('.card-trigger').evaluate((e) => ({
          color: getComputedStyle(e.querySelector('.status-indicator'))
            .getPropertyValue('--status-color')
            .trim(),
          symbol: e.querySelector('.status-symbol').textContent,
          label: e.getAttribute('aria-label'),
        })),
      );
    }
    check(
      new Set(statusCues.map((c) => c.color)).size === 5 &&
        new Set(statusCues.map((c) => c.symbol)).size === 5 &&
        statusCues.some((c) => c.label.includes('Waiting on you')) &&
        statusCues.some((c) => c.label.includes('Waiting on reviewer')),
      'Status colors have distinct symbols and preserve accessible waiting-owner labels',
    );
    await pushFixture(statusFixture('starting', 'Starting chat'));
    await page.locator('#queue .status-indicator[data-status=working]').waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(
      await page
        .locator('#queue .status-indicator')
        .evaluate(
          (e) =>
            getComputedStyle(e, '::after').animationName === 'none' &&
            getComputedStyle(e, '::after').display === 'block',
        ),
      'Reduced motion keeps the working arc visible without rotation',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await pushFixture(baseline);
    const cuePreview = structuredClone(baseline);
    cuePreview.ready = 0;
    cuePreview.working = 1;
    cuePreview.cards = [
      ['needs', 'Approve the compact layout', 'Waiting on you', 'you'],
      ['working', 'Build the chat watcher', 'Working', 'none'],
      ['blocked', 'Fix the installer error', 'Blocked', 'none'],
    ].map(([status, title, label, owner], index) => ({
      ...structuredClone(baseline.cards[0]),
      id: 'status-preview-' + index,
      taskKey: 'status-preview-' + index,
      status,
      title,
      label,
      done: false,
      waitingOn: { kind: owner },
      urgent: false,
      sources: baseline.cards[0].sources.slice(0, 1),
    }));
    await pushFixture(cuePreview);
    await page
      .getByRole('button', { name: 'Build the chat watcher, Working', exact: true })
      .waitFor();
    await page.locator('#queue').screenshot({ path: path.join(output, 'status-indicators.png') });
    await pushFixture(baseline);
    const longTitle =
      'Review the desktop notification behavior with every local Codex chat and a much longer task title';
    const longFixture = structuredClone(baseline);
    longFixture.cards[0].chatName =
      'Desktop notification review with a long source chat name that must stay readable';
    longFixture.cards[0].title = longTitle;
    longFixture.cards[0].sources.find(
      (s) => s.id === longFixture.cards[0].primarySourceId,
    ).taskTitle = longTitle;
    longFixture.cards[0].label = 'Waiting on the desktop application review team';
    await pushFixture(longFixture);
    await page
      .getByRole('button', { name: longTitle + ', ' + longFixture.cards[0].label })
      .waitFor();
    check(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      'Long task and owner names do not overflow',
    );
    await page.screenshot({ path: path.join(output, 'long-text.png') });
    await page
      .getByRole('button', { name: longTitle + ', ' + longFixture.cards[0].label })
      .click({ button: 'right' });
    check(
      (await page.locator('.panel-title').innerText()) === longTitle,
      'Expanded notification reveals the full title',
    );
    await page.keyboard.press('Escape');
    await pushFixture({ ...baseline, cards: [], done: [], ready: 0, working: 0 });
    await page.locator('.empty').waitFor();
    await page.screenshot({ path: path.join(output, 'empty.png') });
    check(
      (await page.locator('.card-trigger').count()) === 0,
      'Empty queue preserves an honest empty state',
    );
    await pushFixture({
      ...baseline,
      health: { ok: false, message: 'Last successful chat data is still available' },
    });
    await waitFor(page, () =>
      document.querySelector('#connection').textContent.startsWith('Sync paused'),
    );
    await page.screenshot({ path: path.join(output, 'sync-paused.png') });
    check(
      (await page.locator('.card-trigger').count()) > 0,
      'Sync failure keeps the last available notifications',
    );
    await pushFixture(baseline);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 590));
    await page.locator('.card-trigger').first().click({ button: 'right' });
    await page.locator('#chat-input').waitFor({ state: 'visible' });
    check(
      await page.locator('#panel').evaluate((e) => e.getBoundingClientRect().bottom <= innerHeight),
      'Compact expanded notification stays within the window',
    );
    check(
      await page.locator('.notification-preview').evaluate((e) => e.getAnimations().length === 0),
      'Reduced motion suppresses expansion animation',
    );
    await page.screenshot({ path: path.join(output, 'compact-hold.png') });
    await page.keyboard.press('Escape');
    await app.evaluate(() => {
      const { contents, original } = globalThis.auditFixtureStateTransport;
      contents.send = original;
      delete globalThis.auditFixtureStateTransport;
    });
    // Exercise the real native show/focus/position controls with a deterministic cursor feed.
    await app.evaluate(({ app, screen }) => {
      screen.getCursorScreenPoint = () => ({ x: 100000, y: 100000 });
      if (process.platform === 'win32') {
        process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs')(
          './src/taskbar.cjs',
        ).readLayout = () => ({ centered: true, widgets: true });
        const display = screen.getPrimaryDisplay();
        screen.getPrimaryDisplay = () => ({
          ...display,
          workArea: { ...display.bounds, height: display.bounds.height - 48 },
        });
      }
    });
    const launcherReady = app.waitForEvent('window');
    await page.evaluate(() => window.workUpdates.settings({ corner: true }));
    const launcherPage = await launcherReady;
    await launcherPage.locator('#corner-toggle').waitFor();
    await page.locator('#hide').click();
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'hidden',
      'The visible X hides the retained queue',
    );
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['Work Updates.exe']));
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'hidden',
      'Relaunch with the weather shortcut enabled leaves the queue concealed',
    );
    await app.evaluate(({ app }) =>
      app.emit('second-instance', {}, ['Work Updates.exe', '--show']),
    );
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'pinned',
      'An explicit show request still opens the retained queue',
    );
    await page.locator('#hide').click();
    const launcherBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => /\/(corner|weather)\.html$/.test(w.webContents.getURL()))
        .getBounds(),
    );
    if (process.platform === 'win32') {
      check(
        (await launcherPage.locator('img').count()) === 0 &&
          (await launcherPage.locator('#corner-toggle').textContent()) === '',
        'Weather area has no added W, icon, or text',
      );
      const material = await launcherPage.locator('#corner-toggle').evaluate((el) => {
        const css = getComputedStyle(el);
        return { color: css.backgroundColor, shadow: css.boxShadow, radius: css.borderRadius };
      });
      check(
        material.color === 'rgba(0, 0, 0, 0.004)' &&
          material.shadow === 'none' &&
          material.radius === '0px',
        'Weather control adds no visible card treatment: ' + JSON.stringify(material),
      );
      const nativeTarget = await app.evaluate(async ({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith('/weather.html'),
        );
        const bitmap = (await w.webContents.capturePage()).getBitmap();
        let alpha = 0;
        for (let i = 3; i < bitmap.length; i += 4) alpha = Math.max(alpha, bitmap[i]);
        return {
          bounds: w.getBounds(),
          display: screen.getPrimaryDisplay(),
          shadow: w.hasShadow(),
          focusable: w.isFocusable(),
          alpha,
        };
      });
      check(
        nativeTarget.bounds.y ===
          nativeTarget.display.workArea.y + nativeTarget.display.workArea.height &&
          nativeTarget.bounds.width === 144 &&
          nativeTarget.bounds.height === 48,
        'Weather input region sits inside the taskbar strip',
      );
      check(
        !nativeTarget.shadow && !nativeTarget.focusable && nativeTarget.alpha <= 1,
        'Native weather region remains visually transparent and unfocusable: alpha=' +
          nativeTarget.alpha,
      );
    }
    const cursor = async (point) =>
      app.evaluate(({ screen }, value) => {
        screen.getCursorScreenPoint = () => value;
      }, point);
    const atCorner = {
      x: launcherBounds.x + Math.floor(launcherBounds.width / 2),
      y: launcherBounds.y + Math.floor(launcherBounds.height / 2),
    };
    const waitForMode = async (mode) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if ((await page.evaluate(() => window.workUpdates.state())).value.windowMode === mode)
          return;
        await page.waitForTimeout(100);
      }
      throw new Error('Native window did not reach ' + mode);
    };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.workUpdates.settings({ pin: false }));
    let weatherHit;
    if (process.platform === 'win32') {
      const target = await app.evaluate(async ({ BrowserWindow, screen }) => {
        const control = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith('/weather.html'),
        );
        const bounds = control.getBounds();
        const handle = control.getNativeWindowHandle();
        globalThis.taskbarChallenger = new BrowserWindow({
          ...bounds,
          frame: false,
          transparent: true,
          backgroundColor: '#00000001',
          show: false,
          focusable: false,
          hasShadow: false,
          skipTaskbar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        await taskbarChallenger.loadURL(
          'data:text/html,<html style="background:rgba(0,0,0,0.004)"></html>',
        );
        taskbarChallenger.setAlwaysOnTop(true, 'pop-up-menu');
        taskbarChallenger.showInactive();
        taskbarChallenger.moveTop();
        await taskbarChallenger.webContents.capturePage();
        const challengerHandle = taskbarChallenger.getNativeWindowHandle();
        return {
          point: screen.dipToScreenPoint({ x: bounds.x + 70, y: bounds.y + 24 }),
          handle: (handle.length === 8
            ? handle.readBigUInt64LE()
            : BigInt(handle.readUInt32LE())
          ).toString(),
          challengerHandle: (challengerHandle.length === 8
            ? challengerHandle.readBigUInt64LE()
            : BigInt(challengerHandle.readUInt32LE())
          ).toString(),
        };
      });
      weatherHit = (expectedHandle = target.handle) =>
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(root, 'tests', 'native-weather-hit.ps1'),
            '-X',
            String(target.point.x),
            '-Y',
            String(target.point.y),
            '-ExpectedHandle',
            expectedHandle,
          ],
          { windowsHide: true, encoding: 'utf8', timeout: 30000 },
        ).trim() === 'true';
      check(
        weatherHit(target.challengerHandle),
        'A competing native surface initially receives the weather hit',
      );
    }
    await cursor(atCorner);
    await waitForMode('peek');
    await page.waitForTimeout(300);
    if (weatherHit) {
      check(weatherHit(), 'Hover restores the actual Windows click target above the taskbar');
      await app.evaluate(() => globalThis.taskbarChallenger.destroy());
    }
    const unpinnedPeek = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      );
      return { above: w.isAlwaysOnTop(), focused: w.isFocused(), focusable: w.isFocusable() };
    });
    check(
      unpinnedPeek.above && !unpinnedPeek.focused,
      'Hover preview rises without focus when the retained-window pin setting is off: ' +
        JSON.stringify(unpinnedPeek),
    );
    await page.locator('#view-menu').click();
    await waitForMode('pinned');
    check(
      await app.evaluate(
        ({ BrowserWindow }) =>
          !BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().endsWith('/index.html'))
            .isAlwaysOnTop(),
      ),
      'Retaining the preview restores the chosen pin setting',
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.workUpdates.window({ action: 'hide' }));
    await cursor({ x: 100000, y: 100000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.workUpdates.settings({ pin: true }));
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.hoverCards = [...document.querySelector('#queue').children];
      window.hoverRedraws = 0;
      window.hoverObserver = new MutationObserver(() => window.hoverRedraws++);
      window.hoverObserver.observe(document.querySelector('#queue'), { childList: true });
      window.motionFrames = [];
      document.documentElement.addEventListener('transitionrun', (event) => {
        if (event.propertyName === 'transform')
          window.motionFrames.push({
            entering: document.documentElement.classList.contains('revealed'),
            x: new DOMMatrixReadOnly(getComputedStyle(document.documentElement).transform).m41,
          });
      });
    });
    const ageBefore = await page.locator('.card-age').first().textContent();
    const ageState = (await page.evaluate(() => window.workUpdates.state())).value;
    try {
      await page.evaluate(() => {
        window.auditDateNow = Date.now;
        Date.now = () => window.auditDateNow() + 86400000;
      });
      await app.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith('/index.html'))
          .webContents.send('work-updates:state', state);
      }, ageState);
      await page.waitForFunction(
        (before) => document.querySelector('.card-age').textContent !== before,
        ageBefore,
      );
      check(
        await page.evaluate(
          () =>
            window.hoverRedraws === 0 &&
            window.hoverCards.every(
              (card, index) => document.querySelector('#queue').children[index] === card,
            ),
        ),
        'Elapsed-time labels update in place without rebuilding notification surfaces',
      );
    } finally {
      await page.evaluate(() => {
        Date.now = window.auditDateNow;
      });
      await app.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith('/index.html'))
          .webContents.send('work-updates:state', state);
      }, ageState);
    }
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.hoverShows = 0;
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/index.html'))
        .on('show', () => globalThis.hoverShows++);
    });
    await cursor(atCorner);
    await waitForMode('peek');
    await page.waitForTimeout(200);
    const nativePeek = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      );
      return { visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable() };
    });
    check(
      nativePeek.visible && !nativePeek.focused,
      'Native hover peek opens without stealing focus: ' + JSON.stringify(nativePeek),
    );
    const peekBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/index.html'))
        .getBounds(),
    );
    await cursor({ x: peekBounds.x + 200, y: peekBounds.y + 200 });
    await page.waitForTimeout(600);
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'peek',
      'Moving into the queue preserves the peek',
    );
    await cursor({ x: 100000, y: 100000 });
    await waitForMode('hidden');
    check(true, 'Leaving a native peek hides it');
    for (let cycle = 0; cycle < 2; cycle++) {
      await cursor(atCorner);
      await waitForMode('peek');
      const unchanged = (await page.evaluate(() => window.workUpdates.state())).value;
      await app.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith('/index.html'))
          .webContents.send('work-updates:state', state);
      }, unchanged);
      await page.waitForTimeout(150);
      await cursor({ x: 100000, y: 100000 });
      await waitForMode('hidden');
    }
    check(
      await page.evaluate(
        () =>
          window.hoverRedraws === 0 &&
          window.hoverCards.every(
            (card, index) => document.querySelector('#queue').children[index] === card,
          ),
      ),
      'Repeated hover and identical watcher updates keep notification nodes intact',
    );
    check(
      (await app.evaluate(() => globalThis.hoverShows)) === 0,
      'Repeated hover never cycles the native surface visibility',
    );
    await page.waitForTimeout(300);
    check(
      await page.evaluate(
        () =>
          window.motionFrames.some((frame) => frame.entering && frame.x < -100) &&
          window.motionFrames.some((frame) => !frame.entering && frame.x <= 0),
      ),
      'Rendered reveal and dismissal both travel from or toward the left',
    );
    check(
      await page.evaluate(
        () =>
          new DOMMatrixReadOnly(getComputedStyle(document.documentElement).transform).m41 <=
            -innerWidth && getComputedStyle(document.documentElement).opacity === '0',
      ),
      'Dismissal finishes outside the viewport on the left',
    );
    const captureConcealed = () => app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      );
      const bitmap = (await w.webContents.capturePage()).getBitmap();
      let alpha = 0;
      for (let i = 3; i < bitmap.length; i += 4) alpha = Math.max(alpha, bitmap[i]);
      return { alpha, focused: w.isFocused(), focusable: w.isFocusable(), shadow: w.hasShadow() };
    });
    // The computed CSS state can precede the compositor's captured frame.
    // Require a fresh fully concealed capture within the bounded render window.
    let concealed;
    const concealDeadline = Date.now() + 1500;
    do {
      concealed = await captureConcealed();
      if (concealed.alpha === 0 && !concealed.focused && !concealed.focusable && !concealed.shadow) break;
      await page.waitForTimeout(50);
    } while (Date.now() < concealDeadline);
    check(
      concealed.alpha === 0 && !concealed.focused && !concealed.focusable && !concealed.shadow,
      'Concealed native surface has no visible pixels, focus or shadow: ' +
        JSON.stringify(concealed),
    );
    check(
      await page.evaluate(() => document.body.inert),
      'Concealed queue is excluded from keyboard and assistive navigation',
    );
    await cursor(atCorner);
    await waitForMode('peek');
    await page.evaluate(() => window.workUpdates.window({ action: 'hide' }));
    await page.waitForTimeout(70);
    await page.evaluate(() => window.workUpdates.window({ action: 'corner' }));
    await waitForMode('pinned');
    await page.waitForTimeout(300);
    check(
      await page.evaluate(
        () =>
          getComputedStyle(document.documentElement).opacity === '1' &&
          new DOMMatrixReadOnly(getComputedStyle(document.documentElement).transform).m41 === 0 &&
          !document.body.inert,
      ),
      'Reopening during dismissal reverses smoothly and remains open',
    );
    await page.evaluate(() => window.workUpdates.window({ action: 'hide' }));
    await cursor({ x: 100000, y: 100000 });
    await page.waitForTimeout(300);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await cursor(atCorner);
    await waitForMode('peek');
    check(
      await page.evaluate(
        () =>
          document.documentElement.getAnimations().length === 0 &&
          new DOMMatrixReadOnly(getComputedStyle(document.documentElement).transform).m41 === 0,
      ),
      'Reduced motion reveals immediately without sliding',
    );
    await page.evaluate(() => window.workUpdates.window({ action: 'hide' }));
    await cursor({ x: 100000, y: 100000 });
    await page.waitForTimeout(150);
    check(
      await page.evaluate(
        () =>
          document.documentElement.getAnimations().length === 0 &&
          getComputedStyle(document.documentElement).opacity === '0',
      ),
      'Reduced motion conceals immediately without sliding',
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.hoverObserver.disconnect());
    await cursor(atCorner);
    await waitForMode('peek');
    await launcherPage.locator('#corner-toggle').click();
    await waitForMode('pinned');
    await cursor({ x: 100000, y: 100000 });
    await page.waitForTimeout(600);
    check(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith('/index.html'))
          .isVisible(),
      ),
      'Clicking the corner retains the native queue',
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/index.html'))
        .setPosition(120, 80),
    );
    await page.waitForTimeout(150);
    await cursor(atCorner);
    await launcherPage.locator('#corner-toggle').click();
    await page.waitForTimeout(600);
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'hidden',
      'A corner click hides and suppresses immediate hover reopening',
    );
    await launcherPage.locator('#corner-toggle').click();
    check(
      await app.evaluate(({ BrowserWindow }) => {
        const b = BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith('/index.html'))
          .getBounds();
        return b.x === 120 && b.y === 80;
      }),
      'Retained native window restores its moved position',
    );
    await page.evaluate(() => window.workUpdates.window({ action: 'hide' }));
    await cursor({ x: 100000, y: 100000 });
    await page.waitForTimeout(150);
    await cursor(atCorner);
    await waitForMode('peek');
    await page.locator('#view-menu').click();
    check(
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'pinned',
      'Clicking inside the peek retains it',
    );
    await page.keyboard.press('Escape');
    if (process.platform === 'win32') {
      await app.evaluate(({ app, screen }) => {
        process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs')(
          './src/taskbar.cjs',
        ).readLayout = () => ({ centered: false, widgets: true });
        screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
      });
      for (let attempt = 0; attempt < 20 && (await app.windows()).length !== 1; attempt++)
        await page.waitForTimeout(50);
      check(
        (await app.windows()).length === 1 &&
          (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'pinned',
        'Changing to left alignment removes the input region and keeps the retained queue open',
      );
      const restored = app.waitForEvent('window');
      await app.evaluate(({ app, screen }) => {
        process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs')(
          './src/taskbar.cjs',
        ).readLayout = () => ({ centered: true, widgets: true });
        screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
      });
      await (await restored).locator('#corner-toggle').waitFor();
      check((await app.windows()).length === 2, 'A supported layout restores the weather region');
    }
    await page.evaluate(() => window.workUpdates.settings({ corner: false }));
    check((await app.windows()).length === 1, 'Disabling the launcher removes its native control');
    await page.locator('.grouped .card-trigger').click();
    const replySource = await page.locator('#source-chat').inputValue();
    await app.evaluate(({ app }) => {
      const { DemoCodex } = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/main.cjs')('./src/demo.cjs');
      const original = DemoCodex.prototype.send;
      DemoCodex.prototype.send = function (id, text) {
        globalThis.auditReplySource = id;
        return original.call(this, id, text);
      };
    });
    await page.locator('#chat-input').fill('Verify the selected chat receives this sample reply.');
    await page.locator('#chat-input').press('Enter');
    await waitFor(
      page,
      () =>
        document.querySelectorAll('.message.user').length === 1 &&
        document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    check(
      await page.locator('#scrim').isVisible(),
      'Reply adoption keeps task information open after Enter',
    );
    check(
      (await app.evaluate(() => globalThis.auditReplySource)) === replySource,
      'The group reply reaches the same selected chat id',
    );
    check(
      (await page.locator('#context-host .body-text').count()) === 0,
      'Acquiring the selected chat removes its older read-only context instead of duplicating the live conversation',
    );
    check(errors.length === 0, 'No renderer exceptions');
    process.stdout.write(
      'Native desktop UI: ' + checks + ' checks passed. Synthetic screenshots: artifacts/ui\n',
    );
  } finally {
    try {
      if (app) await app.evaluate(() => {
        const fixture = globalThis.auditFixtureStateTransport;
        if (fixture) fixture.contents.send = fixture.original;
        delete globalThis.auditFixtureStateTransport;
      }).catch(() => {});
      await closeAuditApp(app);
    } finally {
      clearTimeout(deadline);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
