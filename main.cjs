'use strict';
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  protocol,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  dialog,
  screen,
  globalShortcut,
  clipboard,
  safeStorage,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto=require('node:crypto');
const {inspectStores,versions:storeVersions}=require('./src/private-store.cjs');
const {acquireBackend,maintenanceActive}=require('./src/profile-lease.cjs');
const { Queue, read, atomic, now } = require('./src/queue.cjs');
const { Codex } = require('./src/codex.cjs');
const { Controller } = require('./src/controller.cjs');
const { startObserver } = require('./src/observer.cjs');
const { WindowController } = require('./src/window-controller.cjs');
const { taskSource } = require('./src/task-source.cjs');
const taskbar = require('./src/taskbar.cjs');
const { dataDirectory, startsVisible } = require('./src/background.cjs');
const { createTray } = require('./src/tray.cjs');
const { DiagnosticLog, connectionHealth, recovery } = require('./src/diagnostics.cjs');
const { exportDiagnosticReport:saveDiagnosticReport }=require('./src/diagnostic-export.cjs');
const { Devices } = require('./src/devices.cjs');
const { Summaries } = require('./src/summaries.cjs');
const { NativeControl } = require('./src/native-control.cjs');
const { CodexDesktop } = require('./src/codex-desktop.cjs');
const { Messages } = require('./src/messages.cjs');
const { Assistant } = require('./src/assistant.cjs');
const { Responsibilities }=require('./src/responsibilities.cjs');
const responsibilityTarget=require('./src/responsibility-target.cjs');
const {Schedules}=require('./src/schedules.cjs');
const scheduledResponsibility=require('./src/scheduled-responsibility.cjs');
const {Authorization}=require('./src/authorization.cjs');
const responsibilityAuthorization=require('./src/responsibility-authorization.cjs');
const {Commitments}=require('./src/commitments.cjs');
const {Research}=require('./src/research.cjs');
const {Reflections}=require('./src/reflections.cjs');
const {OutcomeVerification}=require('./src/outcome-verification.cjs');
const {Triage}=require('./src/triage.cjs');
const {Delegations}=require('./src/delegations.cjs');
const {WorkControls}=require('./src/work-controls.cjs');
const {AssistantProfile,capabilities:profileCapabilities}=require('./src/assistant-profile.cjs');
let assistantProfile;
const {VoiceSession}=require('./src/voice-session.cjs');
const {VoiceProvider}=require('./src/voice-provider.cjs');
const {VoiceWindow}=require('./src/voice-window.cjs');
let nativeControl,delegations,workControls;
let privacy;
const args = process.argv;
function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const demo = args.includes('--demo');
const {nativeView, cardView} = require('./src/native-view.cjs');
const {Attachments}=require('./src/attachments.cjs');
let retryFailedSummaries = args.includes('--retry-failed-summaries');
const dataDir = dataDirectory({
  explicit: argument('--data-dir'),
  platform: process.platform,
  packaged: app.isPackaged,
  executable: process.execPath,
  fallback: app.getPath('userData'),
  isFile: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
});
const nativeBackend = args.includes('--native-backend') ||
  (process.platform === 'win32' && fs.existsSync(path.join(dataDir, 'native-backend.enabled')));
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setName('Hyphen');
app.setAppUserModelId('io.workupdates.desktop');
protocol.registerSchemesAsPrivileged([
  { scheme: 'work-updates', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!demo && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
let profileLease;
try{profileLease=acquireBackend(dataDir);inspectStores(dataDir);}
catch(error){profileLease?.close();dialog.showErrorBox('Hyphen needs recovery',error.message);app.quit();process.exit(1);}
process.once('exit',()=>profileLease.close());
const attachments=new Attachments(dataDir);
const updateIdentity={updateToken:process.env.HYPHEN_UPDATE_TOKEN||null,
  sourceHash:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  packageHash:app.isPackaged?crypto.createHash('sha256').update(require('original-fs').readFileSync(path.join(process.resourcesPath,'app.asar'))).digest('hex'):null,
  protocols:{descriptor:1,snapshot:1},storeVersions};
let window,
  tray,
  corner,
  observer,
  summaries,
  hostPeer,
  windowController,
  cornerTimer,
  runtimeTimer,
  concealTimer,
  quitting = false;
let launcherInfo = {
  target: process.platform === 'win32' ? 'weather' : 'corner',
  bounds: null,
  message: '',
};
const diagnostics = new DiagnosticLog(path.join(dataDir, 'logs'),{protectedDirectory:dataDir,metadata:{version:app.getVersion(),nativeProtocol:'work-updates-native-v1',snapshotProtocol:1,
  backendHash:require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}});
diagnostics.write('app.started', { version: app.getVersion(), pid: process.pid, demo });
const queue = new Queue(dataDir);
const client = demo
  ? new (require('./src/demo.cjs').DemoCodex)()
  : new Codex({ binary: queue.state.settings.codexBinary, log: diagnostics });
const desktop = demo ? null : new CodexDesktop({log:diagnostics});
const controller = new Controller(queue, client, {desktop,log:diagnostics,sourceAccess:sourceId=>!privacy?.disconnected(sourceId)&&!privacy?.activeRemoval});
function authorizationAdmission(entry){
  if(privacy?.disconnected(entry.sourceId))return 'deny';
  if(privacy?.activeRemoval)return 'wait';
  const work=workControls?.messageAdmission(entry);if(work&&work!=='allow')return work;
  const childAdmission=delegations?.admission(entry);if(childAdmission&&childAdmission!=='allow')return childAdmission;
  const scheduled=scheduledResponsibility.admission(responsibilities,schedules,entry);if(scheduled!=='allow')return scheduled;
  try{return responsibilityAuthorization.messageAdmission(authorization,responsibilities,devices.snapshot(),entry,schedules);}catch{diagnostics.write('authorization.recovery_failed',{code:'AUTHORIZATION_STORAGE_FAILED',noResend:true});return 'wait';}
}
const messages = new Messages(queue,controller,{log:diagnostics,attachments,admission:authorizationAdmission,authorize:input=>{const work=workControls?.messageAdmission(input);if(work&&work!=='allow')return {decision:work==='wait'?'ask':'deny',reason:'work_control_hold'};const child=delegations?.admission(input,{creating:true});return child&&child!=='allow'?{decision:child==='wait'?'ask':'deny',reason:'delegation_writer_or_permission_gate'}:responsibilityAuthorization.authorizeDispatch(authorization,input,devices.snapshot());}});
const devices = new Devices({
  directory: dataDir,
  state: () => ({...(privacy?privacy.filterSnapshot(messages.decorate(queue.snapshot())):messages.decorate(queue.snapshot())),profile:assistantProfile?.snapshot()}),
  command: performLocal,
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
});
diagnostics.setContext({deviceId:devices.local.id});
assistantProfile=new AssistantProfile({directory:dataDir,actorId:'human:'+devices.local.id,onChange:()=>publish()});
const authorization=new Authorization({directory:dataDir,actorId:'human:'+devices.local.id});
const executors=new (require('./src/executor-bindings.cjs').ExecutorBindings)({directory:dataDir,deviceId:devices.local.id,actorId:authorization.actorId});
if(!demo)client.options.executors=executors;
const commitments=new Commitments({directory:dataDir,humanActorId:'human:'+devices.local.id});
const researchReader=require('./src/research-reader.cjs').reader(app.isPackaged?{helper:path.join(process.resourcesPath,'helper',process.platform==='win32'?'collector.exe':'collector'),helperScript:path.join(process.resourcesPath,'helper','collector.py')}:{});
const research=new Research({directory:dataDir,policy:authorization,reader:researchReader,snapshot:()=>devices.snapshot(),preferences:()=>commitments.preferenceSnapshot(),maintenance:()=>quitting||maintenanceActive(dataDir),log:diagnostics,admission:scope=>privacy?.disconnected(scope.sourceId)||privacy?.activeRemoval?'deny':workControls?.readAdmission(scope)||'allow'});
const reflections=new Reflections({directory:dataDir,policy:authorization,research,commitments,maintenance:()=>quitting||maintenanceActive(dataDir)});
const responsibilities=new Responsibilities({directory:dataDir,snapshot:()=>devices.snapshot(),log:diagnostics,maintenance:()=>quitting||maintenanceActive(dataDir),...responsibilityTarget,
  admission:entry=>workControls?.responsibilityAdmission(entry)||'allow',
  authorize:entry=>delegations?.authorize(entry)||responsibilityAuthorization.prepare(authorization,entry,devices.snapshot(),entry.currentStep.schedule?schedules.entry(entry.currentStep.schedule.id):null),
  outcome:require('./src/assistant-coordination.cjs').outcome,
  dispatch:(mode,input)=>devices.command(mode==='queue'?'queueMessage':'send',input),cancel:input=>devices.command('cancelMessage',input)});
const schedules=new Schedules({directory:dataDir,log:diagnostics,maintenance:()=>quitting||maintenanceActive(dataDir),
  probe:entry=>workControls&&workControls.scheduleAdmission(entry)!=='allow'?{eligible:false,reason:'work_control_hold'}:scheduledResponsibility.probe(responsibilities,entry),run:entry=>scheduledResponsibility.run(responsibilities,entry),outcome:(entry,run)=>scheduledResponsibility.outcome(responsibilities,entry,run)});
delegations=new Delegations({directory:dataDir,policy:authorization,messages,responsibilities,snapshot:()=>devices.snapshot(),log:diagnostics,workAdmission:entry=>workControls?.responsibilityAdmission(entry)||'allow'});
workControls=new WorkControls({directory:dataDir,policy:authorization,messages,responsibilities,schedules,delegations,snapshot:()=>devices.snapshot(),research:()=>research,interrupt:input=>controller.stopSource(input)});
const budgets=new (require('./src/resource-budgets.cjs').ResourceBudgets)({directory:dataDir,actorId:authorization.actorId,responsibilities,snapshot:()=>devices.snapshot(),
  scopes:(id,input)=>{const matches=input.kind==='read'?responsibilities.state.entries.filter(r=>r.scope.sourceId===input.sourceId||r.id===input.taskKey):responsibilities.state.entries.filter(r=>r.currentStep.messageId===id);return matches.flatMap(r=>{const d=delegations.state.entries.find(d=>d.childId===r.id);return [r.id,...(d?[d.parentId]:[])];});}});
messages.budgets=budgets;
research.options.reader=budgets.reader(researchReader);
const voiceProvider=new VoiceProvider({directory:dataDir,actorId:'human:'+devices.local.id,
  encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v),
  available:()=>safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text'});
const voice=new VoiceSession({directory:dataDir,actorId:'human:'+devices.local.id,provider:voiceProvider,budgets,
  admission:()=>quitting||maintenanceActive(dataDir)||workControls.closed||workControls.storageFailed||workControls.active('all','all')?'wait':'allow'});
let voiceWindow;
function openVoice(){voiceWindow??=new VoiceWindow({BrowserWindow,session:require('electron').session,ipcMain,ledger:voice,provider:voiceProvider,actorId:voice.actorId});return voiceWindow.open();}
const githubOutcomes=new (require('./src/outcome-github.cjs').PublicGitHubPR)({budgets});
const outcomes=new OutcomeVerification({directory:dataDir,actorId:'human:'+devices.local.id,responsibilities,github:githubOutcomes,snapshot:()=>devices.snapshot(),maintenance:()=>quitting||maintenanceActive(dataDir),admission:entry=>workControls.responsibilityAdmission(entry)});
const browserVault=new (require('./src/browser-vault.cjs').BrowserVault)({directory:dataDir,encrypt:value=>safeStorage.encryptString(value),decrypt:bytes=>safeStorage.decryptString(bytes),available:()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text')});
const browsers=new (require('./src/browser-sessions.cjs').BrowserSessions)({directory:dataDir,actorId:authorization.actorId,vault:browserVault,budgets,
  admission:()=>quitting||maintenanceActive(dataDir)||workControls.closed||workControls.storageFailed||workControls.active('all','all')?'deny':'allow',
  verifyBinding:async(taskId,grantId)=>{const entry=executors.state.entries.find(e=>e.taskId===taskId&&e.id===grantId);if(!entry)throw new Error('Choose an exact current owned local executor grant.');await client.connect();executors.assert(entry,await client.executorRuntime(),entry.workspace);},
  create:require('./src/browser-electron.cjs').createFactory({BrowserWindow,session})});
const documents=new (require('./src/documents.cjs').Documents)({directory:dataDir,actorId:authorization.actorId,budgets,
  admission:()=>quitting||maintenanceActive(dataDir)||privacy?.activeRemoval||workControls.closed||workControls.storageFailed||workControls.active('all','all')?'deny':'allow'});
responsibilities.options.outcomeRequired=entry=>outcomes.required(entry);
responsibilities.options.outcomeAdmission=(entry,human)=>outcomes.admission(entry,human);
const assistant = new Assistant({directory:dataDir,snapshot:()=>devices.snapshot(),attachments,
  budgets,
  profile:assistantProfile,capabilities:()=>profileCapabilities({assistant,executors,documents,voice:assistant.options.voice,browsers:assistant.options.browsers,peerContract:require('./src/peer-contract.cjs').capabilities(),helper:client.status?.()}),
  voice,openVoice,
  privacy:null,
  executors,
  outcomes,
  responsibilities,
  schedules,
  authorization,
  authorizationRequest:id=>{const entry=messages.state.entries.find(e=>e.id===id&&e.status==='queued');return entry?responsibilityAuthorization.dispatchRequest({...entry,messageId:id},devices.snapshot()):null;},
  commitments,
  research,
  reflections,
  delegations,
  workControls,
  browsers,
  documents,
  binary:queue.state.settings.codexBinary,log:diagnostics,
  loadContext:targets=>require('./src/assistant-context.cjs').loadContext({
    snapshot:()=>devices.snapshot(),
    subscribe:changed=>{queue.on('change',changed);devices.on('change',changed);return()=>{queue.off('change',changed);devices.off('change',changed);};},
    request:targets=>Promise.allSettled(targets.map(target=>workControls.readAdmission(target)!=='allow'?Promise.resolve({skipped:true}):devices.command('details',{id:target.id,taskKey:target.taskKey,sourceId:target.sourceId}))),
  },targets),
  dispatch:(mode,input)=>devices.command(mode==='cancel'?'cancelMessage':mode==='queue'?'queueMessage':'send',input)});
privacy=new (require('./src/privacy.cjs').Privacy)({directory:dataDir,actorId:authorization.actorId,
  localSource:sourceId=>queue.cards().some(c=>c.sources?.some(s=>s.id===sourceId)),
  disconnect:async sourceId=>{observer?.ignore?.(privacy.state.disconnected);publish();},
  adapters:require('./src/privacy-adapters.cjs').adapters({directory:dataDir,assistant:()=>assistant,
    sourceDependencies:sourceId=>[
      ...(research.snapshot().some(e=>e.scope.sourceId===sourceId&&research.pending.has(e.id))?['A selected source read is still running']:[]),
      ...(assistant.state.messages.some(m=>m.status==='thinking'&&!/^\/privacy(?:\s|$)/.test(m.text))?['An assistant answer is still using retained source context']:[]),
    ],
    sourcePaused:async operation=>{const previous=observer;await previous?.closeAndWait?.();if(previous&&!previous.closeAndWait)throw new Error('Collector shutdown cannot be verified. Removal is held.');try{return await operation();}finally{if(previous&&!quitting)startCollection();}},
    forgetFeed:sourceId=>queue.setFeed({...queue.feed,threads:queue.feed.threads.filter(t=>t.id!==sourceId)},queue.health),
    retained:require('./src/privacy-retained-adapters.cjs').retainedAdapters({directory:dataDir,assistant:()=>assistant,
      research:()=>research,reflections:()=>reflections,messages:()=>messages,attachments,voice:()=>voice,diagnostics:()=>diagnostics,
      documents:()=>documents,browsers:()=>browsers,browserVault})})});
assistant.options.privacy=privacy;
const triage=new Triage({directory:dataDir,policy:authorization,responsibilities,research,snapshot:()=>devices.snapshot(),deviceId:devices.local.id,
  preferences:()=>commitments.preferenceSnapshot(),maintenance:()=>quitting||maintenanceActive(dataDir),
  admission:entry=>assistant.options.workControls?.responsibilityAdmission(entry)||'allow',
  destination:require('./src/notification-destination.cjs').destination({assistant,deviceId:devices.local.id,Notification,show:()=>show(),
    systemEnabled:()=>queue.state.settings.attention&&(!windowController||windowController.mode==='hidden')})});
assistant.options.triage=triage;
const activity=new (require('./src/activity.cjs').Activity)({directory:dataDir,actorId:()=>authorization.actorId,snapshot:()=>devices.snapshot(),maintenance:()=>quitting||maintenanceActive(dataDir),collectorScope:sourceId=>{const card=devices.snapshot().cards.find(c=>c.sources?.some(s=>s.id===sourceId));return {sourceId,ownerId:card?.owner?.id||devices.local.id,deviceId:devices.local.id,taskKey:card?.taskKey};}});
activity.attach({policy:authorization,responsibilities,schedules,research,delegations,triage,messages});
research.options.reader=activity.reader(research.options.reader,research);
responsibilities.options.dispatch=activity.dispatch(responsibilities.options.dispatch,responsibilities);
assistant.options.activity=activity;
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'";
function snapshot() {
  const state = devices.snapshot();
  return {
    ...state,
    assistant: assistant.snapshot(),
    profile:assistantProfile.snapshot(),
    budgets:budgets.inspect(),
    connectionHealth:connectionHealth({collectedAt:state.collectedAt,collector:queue.health,helper:client.status?.(),desktopConnected:desktop?.status().connected,
      pipeListening:!!nativeControl?.server?.listening,nativeClients:nativeControl?.clients.size,devices:state.devices}),
    settings: {
      ...state.settings,
      ...Object.fromEntries(
        ['pin', 'corner', 'attention', 'shortcut'].map((k) => [k, queue.state.settings[k]]),
      ),
    },
    addresses: require('./src/peer.cjs')
      .interfaces()
      .filter((a) => !a.startsWith('127.')),
    demo,
    platform: process.platform,
    version: app.getVersion(),
    hosting: !!hostPeer?.server,
    windowMode: windowController?.mode || 'hidden',
    launcher: { ...launcherInfo, active: !!corner && !corner.isDestroyed() },
  };
}
function publish() {
  const state = snapshot();
  tray?.update(state);
  if (window && !window.isDestroyed()) window.webContents.send('work-updates:state', state);
  if (corner && !corner.isDestroyed())
    corner.webContents.send('work-updates:state', { windowMode: state.windowMode });
  hostPeer?.broadcast(devices.localState());
  nativeControl?.broadcast(nativeView(state));
}
messages.on('change', () => {try{responsibilityAuthorization.observe(authorization,messages);}catch{diagnostics.write('authorization.recovery_failed',{code:'AUTHORIZATION_STORAGE_FAILED',noResend:true});}publish();});
authorization.on('change',()=>{publish();queueMicrotask(()=>messages.pump().catch(()=>diagnostics.write('authorization.recovery_failed',{code:'AUTHORIZATION_STORAGE_FAILED',noResend:true})));});
assistant.on('change', () => publish());
workControls.on('change',()=>publish());
commitments.on('change',()=>publish());
research.on('change',()=>publish());
function driveResearch(){void research.tick().catch(()=>diagnostics.write('research.recovery_failed',{code:'RESEARCH_STORAGE_FAILED',noResend:true}));}
const researchTimer=setInterval(driveResearch,60000);researchTimer.unref();queueMicrotask(driveResearch);
function driveReflections(){try{reflections.tick();}catch{diagnostics.write('reflection.recovery_failed',{code:'REFLECTION_STORAGE_FAILED',noResend:true});}}
reflections.on('change',()=>publish());
const reflectionTimer=setInterval(driveReflections,60000);reflectionTimer.unref();queueMicrotask(driveReflections);
function driveTriage(){void triage.pump().catch(()=>diagnostics.write('notification.recovery_failed',{code:'NOTIFICATION_STORAGE_FAILED',noResend:true}));}
triage.on('change',()=>publish());
const triageTimer=setInterval(driveTriage,60000);triageTimer.unref();queueMicrotask(driveTriage);
function driveDocuments(){try{documents.tick();}catch{diagnostics.write('app.command.failed',{code:'DOCUMENT_STORAGE_FAILED',noResend:true});}}
const documentTimer=setInterval(driveDocuments,60000);documentTimer.unref();queueMicrotask(driveDocuments);
function driveDelegations(){void delegations.tick().catch(()=>diagnostics.write('delegation.recovery_failed',{code:'DELEGATION_RECOVERY_FAILED',noResend:true}));}
delegations.on('change',()=>publish());
const delegationTimer=setInterval(driveDelegations,60000);delegationTimer.unref();
queueMicrotask(driveDelegations);
function driveSchedules(){try{schedules.observe();}catch{diagnostics.write('schedule.recovery_failed',{code:'SCHEDULE_RECOVERY_FAILED',noResend:true});}void schedules.tick().catch(()=>diagnostics.write('schedule.recovery_failed',{code:'SCHEDULE_RECOVERY_FAILED',noResend:true}));}
schedules.on('change',()=>publish());
responsibilities.on('change',()=>{publish();queueMicrotask(()=>responsibilities.pump());queueMicrotask(driveSchedules);queueMicrotask(driveDelegations);queueMicrotask(driveTriage);});
schedules.start();
devices.on('change', () => {
  responsibilities.observe(devices.snapshot());
  try{workControls.reconcile();}catch{diagnostics.write('work.recovery_failed',{code:'WORK_CONTROL_RECOVERY_FAILED',noResend:true});}
  driveDelegations();
  driveSchedules();
  void responsibilities.pump();
  assistant.observe(devices.snapshot());
  previousRemote = incoming(
    devices.snapshot().cards.filter((c) => !c.owner.local),
    previousRemote,
  );
  publish();
});
let publication;
queue.on('change', () => {
  responsibilities.observe(devices.snapshot());
  driveDelegations();
  driveSchedules();
  void responsibilities.pump();
  assistant.observe(devices.snapshot());
  if (!publication)
    publication = setTimeout(() => {
      publication = null;
      publish();
    }, 60);
});
const notified = new Set();
function attention(event) {
  if (
    triage.managedEvent(event,devices.snapshot()) ||
    !queue.state.settings.attention ||
    (windowController && windowController.mode !== 'hidden') ||
    !['needs', 'blocked', 'waiting', 'ready'].includes(event.status) ||
    !commitments.attention(event) ||
    notified.has(event.key)
  )
    return;
  notified.add(event.key);
  if (notified.size > 500) notified.delete(notified.values().next().value);
  if (Notification.isSupported()) {
    const notification = new Notification({
      title:
        event.status === 'needs' || event.waitingOn?.kind === 'you'
          ? 'Waiting on you'
          : event.urgent
            ? 'Urgent task'
            : event.status === 'ready' ? 'Ready for review' : event.status === 'blocked' ? 'A task is blocked' : 'Task update',
      body: event.title,
    });
    notification.on('click', () => show());
    notification.show();
  }
}
controller.on('attention', attention);
let previousObserved, previousRemote;
function incoming(cards, previous) {
  const next = new Map(
    cards.map((c) => [
      c.id,
      c.fingerprint + ':' + c.status + ':' + c.urgent + ':' + JSON.stringify(c.waitingOn),
    ]),
  );
  if (previous)
    for (const card of cards)
      if (
        previous.get(card.id) !== next.get(card.id) &&
        !card.done &&
        !card.reviewed &&
        !card.snoozed
      )
        attention({
          cardId:card.id,sourceId:card.primarySourceId,
          key: card.id + ':' + next.get(card.id),
          title: card.title,
          status: card.status,
          urgent: card.urgent,
          waitingOn: card.waitingOn,
        });
  return next;
}
function show() {
  windowController?.show();
}
function toggle() {
  windowController?.toggle();
}
app.on('second-instance', (_event, argv) => {
  if (startsVisible(argv)) show();
});
function cornerAvailable() {
  return !!queue.state.settings.corner && !nativeControl?.claimed;
}
function refreshCorner() {
  const previous = JSON.stringify(launcherInfo);
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  launcherInfo =
    process.platform === 'win32'
      ? taskbar.weatherTarget(display, taskbar.readLayout())
      : {
          target: 'corner',
          bounds: { width: 44, height: 44, x: area.x + 12, y: area.y + area.height - 56 },
          message: '',
        };
  if (process.platform === 'win32' && !cornerAvailable() && launcherInfo.bounds)
    launcherInfo.message = 'Weather shortcut off. Windows Widgets uses the weather area.';
  if (!cornerAvailable() || !launcherInfo.bounds) {
    if (windowController.enabled) windowController.enable(false);
    corner?.destroy();
    corner = null;
    if (previous !== JSON.stringify(launcherInfo)) publish();
    return;
  }
  if (corner && !corner.isDestroyed()) {
    if (previous !== JSON.stringify(launcherInfo)) {
      corner.setBounds(launcherInfo.bounds);
      publish();
    }
    return;
  }
  corner = new BrowserWindow({
    ...launcherInfo.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const control = corner;
  control.once('ready-to-show', () => {
    if (corner !== control || control.isDestroyed()) return;
    if (launcherInfo.target === 'weather') control.setAlwaysOnTop(true, 'pop-up-menu');
    control.showInactive();
    if (launcherInfo.target === 'weather') control.moveTop();
    windowController.enable(true);
    publish();
  });
  corner.loadURL(
    'work-updates://app/' + (launcherInfo.target === 'weather' ? 'weather.html' : 'corner.html'),
  );
  corner.webContents.on('will-navigate', (e) => e.preventDefault());
  corner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  corner.webContents.on('did-finish-load', publish);
}
function cornerWindow() {
  clearInterval(cornerTimer);
  refreshCorner();
  if (!cornerAvailable()) return;
  let ticks = 0;
  cornerTimer = setInterval(() => {
    if (++ticks % 100 === 0) refreshCorner();
    if (!corner || corner.isDestroyed() || window.isDestroyed()) return;
    windowController.tick(screen.getCursorScreenPoint());
    if (launcherInfo.target === 'weather' && windowController.onCorner) {
      // Explorer can raise the taskbar after this window was shown. Keep the
      // transparent click target in front while its region is being used.
      if (!corner.isAlwaysOnTop()) corner.setAlwaysOnTop(true, 'pop-up-menu');
      corner.moveTop();
    }
  }, 100);
  cornerTimer.unref();
}
function configureWindowLevel() {
  const above = queue.state.settings.pin !== false || windowController.mode === 'peek';
  if (window.isAlwaysOnTop() !== above)
    // Windows' default floating level moves behind Explorer's taskbar, which
    // can also clear topmost. The queue already stays inside the work area.
    window.setAlwaysOnTop(above, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
}
function configure() {
  if (nativeBackend) return;
  configureWindowLevel();
  cornerWindow();
  globalShortcut.unregisterAll();
  const key = process.platform === 'darwin' ? 'Command+Option+Space' : 'Control+Alt+Space';
  queue.state.settings.shortcut = globalShortcut.register(key, toggle)
    ? key
    : 'Shortcut unavailable';
}
async function perform(method, input = {}) {
  if(!['state','details'].includes(method)&&maintenanceActive(dataDir))throw Object.assign(new Error('Hyphen is completing an update. Wait for maintenance to finish before sending or changing tasks.'),{code:'UPDATE_IN_PROGRESS'});
  const state=devices.snapshot(),card=[...state.cards,...state.done].find(c=>c.id===input.id&&(!input.taskKey||c.taskKey===input.taskKey));
  return diagnostics.scope({messageId:input.messageId,sourceId:input.sourceId,cardId:card?.id,taskKey:card?.taskKey,ownerId:card?.owner?.id},()=>performBound(method,input));
}
async function performBound(method, input = {}) {
  if (
    [
      'create',
      'start',
      'action',
      'undo',
      'send',
      'queueMessage',
      'clearMessages',
      'stop',
      'respond',
      'details',
      'group',
      'refresh',
      'open',
    ].includes(method)
  )
    {
      const result=await devices.command(method,input);
      if(method==='details'){const card=[...devices.snapshot().cards,...devices.snapshot().done].find(c=>c.id===input.id&&(!input.taskKey||c.taskKey===input.taskKey));if(card)assistant.focus(card,input.sourceId);}
      return result;
    }
  return performLocal(method, input);
}
async function performLocal(method, input = {}) {
  if (!['state','details'].includes(method) && maintenanceActive(dataDir))
    throw Object.assign(new Error('Hyphen is completing an update. Wait before changing tasks.'),{code:'UPDATE_IN_PROGRESS',delivery:'not-sent'});
  if (method === 'state') return snapshot();
  if (method === 'attachImages') return {images:attachments.import(input.paths)};
  if (method === 'openAttachment') {
    const image=attachments.resolve([input.attachmentId])[0];
    const error=await shell.openPath(image.path);if(error)throw new Error('This image could not be opened.');return {opened:true};
  }
  if (method === 'assistantAsk') return assistant.ask(input);
  if (method === 'assistantProfile') {
    const value=assistantProfile.update({role:'human',authority:'accepted_human',actorId:assistantProfile.actorId,messageId:crypto.randomUUID()},input);
    return value;
  }
  if (method === 'capabilities')return assistant.options.capabilities();
  if (method === 'assistantUse') {
    const result=assistant.use(input);
    assistant.focus(result.card,result.sourceId);
    return {...result,card:cardView(result.card,true,attachments)};
  }
  if (method === 'create') {
    if (input.cwd && !(queue.state.settings.projects || []).includes(input.cwd))
      throw new Error('Choose a workspace with the folder picker.');
    return queue.create(input);
  }
  if (method === 'start') return controller.start(input.id);
  if (method === 'action') return queue.action(input.id, input.action, input.taskKey);
  if (method === 'undo') return queue.undoLast();
  if (method === 'group') return queue.group(input);
  if (method === 'refresh') {
    observer?.request([]);
    return {};
  }
  if (method === 'retrySummaries') return { queued: summaries?.retryFailed() || 0 };
  if (method === 'send')
    return messages.send(input);
  if (method === 'queueMessage') return messages.enqueue(input);
  if (method === 'cancelMessage') {
    const source=taskSource(queue.get(input.id,input.taskKey),input.sourceId);if(!source)throw new Error('Choose the source of that queued message.');return messages.cancel(input.messageId,source.id);
  }
  if (method === 'clearMessages') {
    const source=taskSource(queue.get(input.id,input.taskKey),input.sourceId);
    return messages.clear(source.id,input.checked===true);
  }
  if (method === 'logs') return exportDiagnosticReport();
  if (method === 'stop') return controller.stop(input.id);
  if (method === 'respond') return controller.respond(input.id, input.decision, input.answers);
  if (method === 'details') {
    const card = messages.decorate({cards:[queue.get(input.id, input.taskKey)]}).cards[0];
    observer?.request(card.sources.filter((s) => !s.contextLoaded||!s.conversationLoaded).map((s) => s.id));
    return card;
  }
  if (method === 'open') {
    const card = queue.get(input.id, input.taskKey);
    if (input.taskKey && card?.taskKey !== input.taskKey)
      throw new Error('This task changed. Reopen its update.');
    const source = taskSource(card, input.sourceId);
    if (!source || !/^[a-f0-9-]{36}$/i.test(source.id))
      throw new Error('No source chat is available.');
    if (demo) return { sourceId: source.id };
    await shell.openExternal('codex://threads/' + source.id);
    return { sourceId: source.id };
  }
  if (method === 'project') {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Choose task workspace',
    });
    if (result.canceled) return {};
    const cwd = result.filePaths[0];
    queue.state.settings.projects = [...new Set([...(queue.state.settings.projects || []), cwd])];
    queue.save();
    return { cwd };
  }
  if (method === 'settings') {
    for (const key of ['pin', 'corner', 'attention', 'aiSummaries'])
      if (typeof input[key] === 'boolean') queue.state.settings[key] = input[key];
    queue.save();
    summaries?.refresh();
    configure();
    return snapshot();
  }
  if (method === 'window') {
    if (input.action === 'hide') windowController.hide();
    else if (input.action === 'toggle') toggle();
    else if (input.action === 'corner') windowController.clickCorner();
    else if (input.action === 'retain') windowController.retain();
    else if (input.action === 'show') show();
    else if (input.action === 'quit') {
      quitting = true;
      app.quit();
    } else if (input.action === 'new') {
      show();
      window.webContents.send('work-updates:state', { ...snapshot(), openComposer: true });
    }
    return {};
  }
  if (method === 'updates') {
    if (demo) return { message: 'Demo mode does not check releases.' };
    const response = await fetch(
      'https://api.github.com/repos/Al-Yousef/work-updates/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok) throw new Error('No published release is available yet.');
    const release = await response.json();
    if (!/^https:\/\/github\.com\/Al-Yousef\/work-updates\/releases\/tag\//.test(release.html_url))
      throw new Error('Unexpected release URL.');
    await shell.openExternal(release.html_url);
    return { version: release.tag_name };
  }
  if (['pair', 'connect', 'disconnect', 'revoke'].includes(method)) {
    return connectionAction(method, input);
  }
  throw new Error('Unknown app action.');
}
async function exportDiagnosticReport() {
  return saveDiagnosticReport(diagnostics,dialog,window,()=>snapshot().connectionHealth);
}
async function connectionAction(method, input) {
  const { HostPeer } = require('./src/peer.cjs');
  if (method === 'disconnect') {
    devices.remove(input.id);
    publish();
    return {};
  }
  if (method === 'revoke') {
    hostPeer?.revoke();
    hostPeer = null;
    publish();
    return { message: 'Pairing revoked. Other devices can no longer access this desktop.' };
  }
  if (method === 'pair') {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Enable your operating system keychain before pairing.');
    hostPeer ??= new HostPeer({
      directory: dataDir,
      encrypt: (v) => safeStorage.encryptString(v),
      decrypt: (v) => safeStorage.decryptString(v),
      state: () => devices.localState(),
      command: async (method, input) => {
        const result = await performLocal(method, input);
        return result?.cards && result?.done ? devices.localState() : result;
      },
    });
    const code = await hostPeer.start(input.host);
    clipboard.writeText(code);
    publish();
    return { message: 'Pairing code copied. Paste it into Hyphen on your Mac or iPhone.' };
  }
  if (method === 'connect') {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Enable your operating system keychain before pairing.');
    return devices.add(input.code);
  }
}
function startCollection() {
  if (argument('--legacy-root')) queue.importLegacy(path.resolve(argument('--legacy-root')));
  if (demo) observer = require('./src/demo.cjs').startDemoObserver(queue);
  else {
    summaries ||= new Summaries(queue, { log: diagnostics });
    const helper = app.isPackaged
      ? path.join(
          process.resourcesPath,
          'helper',
          process.platform === 'win32' ? 'collector.exe' : 'collector',
        )
      : undefined;
    const helperScript = app.isPackaged
      ? path.join(process.resourcesPath, 'helper', 'collector.py')
      : undefined;
    observer = startObserver(
      path.join(dataDir, 'observer'),
      { helper, helperScript, log: diagnostics,ignoredThreadIds:privacy.state.disconnected },
      (feed, health) => {
        queue.setFeed(feed || queue.feed, health);
        if(health.ok)activity.collector(feed?.activityAccess);else if(health.status==='error')activity.collector(health.activityAccess);
        if (feed && health.ok && !maintenanceActive(dataDir)) {
          summaries.refresh();
          if (retryFailedSummaries) {
            retryFailedSummaries = false;
            summaries.retryFailed();
          }
        }
        previousObserved = incoming(
          queue.cards().filter((c) => c.kind === 'observed'),
          previousObserved,
        );
      },
    );
  }
}
function restoreDevices() {
  if (!demo && safeStorage.isEncryptionAvailable()) {
    const { HostPeer } = require('./src/peer.cjs');
    hostPeer = new HostPeer({
      directory: dataDir,
      encrypt: (v) => safeStorage.encryptString(v),
      decrypt: (v) => safeStorage.decryptString(v),
      state: () => devices.localState(),
      command: async (method, input) => {
        const result = await performLocal(method, input);
        return result?.cards && result?.done ? devices.localState() : result;
      },
    });
    if (hostPeer.saved())
      hostPeer
        .restore()
        .then(publish)
        .catch(() => {});
    devices
      .restore()
      .catch((error) => diagnostics.write('devices.restore.failed', { message: error.message }));
  }
}
app.whenReady().then(async () => {
  if (nativeBackend) {
    if (process.platform !== 'win32') throw new Error('The native backend currently requires Windows.');
    startCollection();
    nativeControl = new NativeControl({
      directory: dataDir,
      log:diagnostics,
      changed: claimed => {
        diagnostics.write('native.corner.owner', {owner:claimed?'native':'none'});
        publish();
      },
      state: () => nativeView(snapshot()),
      command: async (method, input) => {
        const result = await perform(method, input);
        return method === 'details' ? cardView(result, true,attachments) : ['send','queueMessage','assistantAsk','assistantUse','attachImages','openAttachment'].includes(method) ? result : {};
      },
      status: () => ({activeWriters:Math.max(client.status?.().active ?? 0, client.status?.().pending ?? 0, queue.busy?.size ?? 0,messages.active.size,desktop?.pending.size||0,assistant.active?1:0,responsibilities.pending.size,schedules.pending.size,research.pending.size,workControls.pending.size,triage.pending.size),
        mode:'native-backend', windowCount:BrowserWindow.getAllWindows().length,
        rendererCount:app.getAppMetrics().filter(p => p.type === 'Tab').length}),
      quit: () => {quitting=true; app.quit();},
    });
    await nativeControl.start();
    restoreDevices();
    const runtime = () => {
      if (quitting) return;
      atomic(path.join(dataDir, 'runtime.json'), {
      appPid:process.pid, version:app.getVersion(), mode:'native-backend',...updateIdentity,
      windowCount:BrowserWindow.getAllWindows().length,
      rendererCount:app.getAppMetrics().filter(p => p.type === 'Tab').length,
      collectorPid:observer?.pid || null, chats:queue.feed.monitoredCount || 0,
      feedCollectedAt:queue.feed.collectedAt || 0, health:queue.health,
      aiSummary:queue.aiSummary, codex:client.status?.() || {active:0, loaded:0},
      productName:'Hyphen', desktop:{connected:!!desktop?.clientId,pending:desktop?.pending.size||0},
      messages:{queued:messages.state.entries.filter(e=>e.status==='queued').length,uncertain:messages.state.entries.filter(e=>e.status==='uncertain').length,active:messages.active.size},
      assistant:{active:assistant.active,model:assistant.provider.model,messages:assistant.state.messages.length,memoryCount:assistant.state.notes.length,error:assistant.error},
      cornerOwner:nativeControl.claimed?'native':'none',
      updatedAt:now(), diagnostics:{file:diagnostics.file, error:diagnostics.error},
      });
    };
    runtime();
    runtimeTimer = setInterval(runtime, 3000); runtimeTimer.unref();
    diagnostics.write('native.backend.ready', {windowCount:0});
    return;
  }

  protocol.handle('work-updates', (request) => {
    const url = new URL(request.url);
    const files = {
      '/index.html': ['index.html', 'text/html'],
      '/corner.html': ['corner.html', 'text/html'],
      '/weather.html': ['weather.html', 'text/html'],
      '/weather.js': ['weather.js', 'text/javascript'],
      '/weather.css': ['weather.css', 'text/css'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
      '/icon.svg': ['../assets/icon.svg', 'image/svg+xml'],
    };
    const entry = files[url.pathname];
    if (url.hostname !== 'app' || !entry) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(__dirname, 'ui', entry[0])), {
      headers: {
        'Content-Type': entry[1],
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
  const saved = queue.state.settings.bounds || {},
    area = screen.getPrimaryDisplay().workArea,
    queueWidth = 420,
    queueHeight = Math.min(880, area.height - 32),
    initiallyVisible = startsVisible(args, demo);
  window = new BrowserWindow({
    width: queueWidth,
    height: queueHeight,
    minWidth: 390,
    minHeight: 590,
    x: Math.max(
      area.x,
      Math.min(saved.x ?? area.x + area.width - queueWidth - 24, area.x + area.width - queueWidth),
    ),
    y: Math.max(area.y, Math.min(saved.y ?? area.y + 24, area.y + area.height - queueHeight)),
    frame: false,
    transparent: true,
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Hyphen',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowController = new WindowController({
    window,
    visible: false,
    present: (visible) => {
      clearTimeout(concealTimer);
      window.setIgnoreMouseEvents(!visible);
      if (visible) {
        configureWindowLevel();
        if (!window.isVisible()) window.showInactive();
        if (windowController.mode === 'pinned') window.moveTop();
      } else
        concealTimer = setTimeout(() => {
          if (!window.isDestroyed() && windowController.mode === 'hidden') {
            // Windows can keep an inactive layered window as foreground after
            // blur(). Release it only once the exit has painted zero alpha.
            const focused = window.isFocused();
            if (focused) window.hide();
            window.setFocusable(false);
            configureWindowLevel();
            if (focused) window.showInactive();
          }
        }, 260);
    },
    launcher: () => corner?.getBounds(),
    workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    saveBounds: (bounds) => {
      queue.state.settings.bounds = bounds;
    },
  });
  windowController.onChange = publish;
  window.once('ready-to-show', () => {
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    if (initiallyVisible || windowController.mode === 'pinned') show();
  });
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      windowController.hide();
    }
  });
  for (const method of [
    'state',
    'create',
    'start',
    'action',
    'undo',
    'send',
    'queueMessage',
    'clearMessages',
    'stop',
    'respond',
    'details',
    'group',
    'refresh',
    'retrySummaries',
    'assistantProfile',
    'capabilities',
    'open',
    'project',
    'settings',
    'window',
    'pair',
    'connect',
    'disconnect',
    'revoke',
    'updates',
  ])
    ipcMain.handle('work-updates:' + method, async (event, input) => {
      if (!event.senderFrame?.url.startsWith('work-updates://app/'))
        return { ok: false, error: 'Unknown app frame.' };
      try {
        return { ok: true, value: await perform(method, input || {}) };
      } catch (error) {
        diagnostics.write('app.command.failed', {
          method,
          taskId: error.taskId,
          code: error.code,
          message: error.message,
          phase:error.phase,delivery:error.delivery,messageId:error.messageId,
        });
        return { ok: false, error: recovery(error).guidance||error.message, taskId: error.taskId,code:error.code,phase:error.phase,delivery:error.delivery,messageId:error.messageId };
      }
    });
  if (process.platform === 'darwin') app.dock?.hide();
  tray = createTray({
    Tray,
    Menu,
    nativeImage,
    nativeTheme,
    assets: path.join(__dirname, 'assets'),
    platform: process.platform,
    demo,
    show,
    hide: () => windowController.hide(),
    create: () => perform('window', { action: 'new' }),
    openLogs: () => exportDiagnosticReport().catch(error=>diagnostics.write('app.command.failed',{method:'logs',code:error.code||'DIAGNOSTIC_EXPORT_FAILED'})),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.update(snapshot());
  startCollection();
  configure();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed'])
    screen.on(event, refreshCorner);
  await window.loadURL('work-updates://app/index.html');
  if (process.platform === 'win32') {
    nativeControl = new NativeControl({
      directory: dataDir,
      log:diagnostics,
      state: () => nativeView(snapshot()),
      command: async (method, input) => {
        const result = await perform(method, input);
        return method === 'details' ? cardView(result, true,attachments) : ['send','queueMessage','assistantAsk','assistantUse','attachImages','openAttachment'].includes(method) ? result : {};
      },
      changed: (claimed) => {
        if (quitting) return;
        cornerWindow();
        if (claimed) windowController.hide();
        diagnostics.write('native.corner.owner', {owner:claimed?'native':'electron'});
        publish();
      },
      status: () => ({
        cornerConfigured: !!queue.state.settings.corner,
        launcherActive: !!corner && !corner.isDestroyed(),
        activeWriters: Math.max(client.status?.().active ?? 0,client.status?.().pending??0,queue.busy.size,messages.active.size,desktop?.pending.size||0,assistant.active?1:0,responsibilities.pending.size,schedules.pending.size,research.pending.size,workControls.pending.size,triage.pending.size),
        windowMode: windowController.mode,
      }),
      quit: () => {quitting = true; app.quit();},
    });
    try { await nativeControl.start(); }
    catch (error) {nativeControl.close(); nativeControl = null; diagnostics.write('native.control.failed', {message:error.message});}
  }
  const runtime = () => {
    if (quitting) return;
    atomic(path.join(dataDir, 'runtime.json'), {
      appPid: process.pid,
      version: app.getVersion(),
      ...updateIdentity,
      collectorPid: observer?.pid || null,
      chats: queue.feed.monitoredCount || 0,
      feedCollectedAt: queue.feed.collectedAt || 0,
      health: queue.health,
      aiSummary: queue.aiSummary,
      visible: windowController.mode !== 'hidden',
      windowMode: windowController.mode,
      cornerEnabled: cornerAvailable(),
      cornerOwner: nativeControl?.claimed ? 'native' : 'electron',
      launcher: { ...launcherInfo, active: !!corner && !corner.isDestroyed() },
      tray: tray.status(),
      codex: client.status?.() || null,
      devices: devices
        .snapshot()
        .devices.map(({ id, name, kind, online }) => ({ id, name, kind, online })),
      diagnostics: { file: diagnostics.file, error: diagnostics.error },
      updatedAt: now(),
    });
  };
  runtime();
  runtimeTimer = setInterval(runtime, 3000);
  runtimeTimer.unref();
  restoreDevices();
  if (args.includes('--dev')) {
    let refresh;
    fs.watch(path.join(__dirname, 'ui'), () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => window.webContents.reload(), 250);
    });
  }
  if (argument('--snapshot'))
    setTimeout(async () => {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.resolve(argument('--snapshot')), image.toPNG());
    }, 4500);
  if (args.includes('--smoke'))
    setTimeout(async () => {
      try {
        await window.webContents.executeJavaScript('document.getElementById("new-task").click()');
        const ok = await window.webContents.executeJavaScript(
          'document.querySelector("#task-prompt") !== null',
        );
        if (!ok) throw new Error('Composer did not open');
        process.stdout.write('Desktop smoke check passed\n');
        quitting = true;
        app.exit(0);
      } catch {
        app.exit(1);
      }
    }, 1300);
});
app.on('activate', () => window && show());
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  browsers.shutdown();
  clearInterval(documentTimer);
  clearInterval(runtimeTimer);
  diagnostics.write('app.stopping', { pid: process.pid });
  queue.save();
  observer?.close();
  summaries?.close();
  client.close();
  desktop?.close();
  messages.close();
  assistant.close();
  voiceWindow?.close();voice.close();
  responsibilities.close();
  schedules.close();
  authorization.close();
  commitments.close();
  research.close();clearInterval(researchTimer);
  activity.close();
  outcomes.close();
  reflections.close();clearInterval(reflectionTimer);
  triage.close();clearInterval(triageTimer);
  delegations.close();clearInterval(delegationTimer);
  workControls.close();
  budgets.close();
  hostPeer?.close();
  devices.close();
  nativeControl?.close();
  globalShortcut.unregisterAll();
  clearInterval(cornerTimer);
  clearTimeout(concealTimer);
  tray?.destroy();
});
