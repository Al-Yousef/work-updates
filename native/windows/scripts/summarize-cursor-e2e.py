import os
"""Summarize the recorded cursor run without converting receipts into UI proof."""
import ctypes as C, hashlib, json, pathlib, shutil
from ctypes import wintypes as W

BASE=pathlib.Path(__file__).resolve().parents[1]
DIRECTORY=BASE/'build/artifacts/cursor-e2e-20261006'
def read(name):return json.loads((DIRECTORY/(name+'.json')).read_text(encoding='utf-8-sig'))
def panel(step):return next(w for w in step['after']['windows'] if 'composer' in w)
def composer_id(step):
    for hit in panel(step).get('audit',{}).get('hits',[]):
        if hit['action']=='addMenu':return hit['key'].split('\n')[1]
    return None
def error(step):return step['receipt'].get('result',{}).get('error')

records={file.stem:json.loads(file.read_text(encoding='utf-8-sig')) for file in DIRECTORY.glob('*.json') if file.name not in ('focus-proof.json','summary.json')}
steps=[step for group in records.values() for step in group]
tests=[]
def case(name,result,observed,evidence):tests.append({'case':name,'result':result,'observed':observed,'evidence':evidence})

switch=read('live-switch-menu')
latencies=[]
for step in (switch[1],switch[3]):
    click=next(e['seconds'] for e in step['events'] if e['event']=='ui-click')
    ready=next(e['seconds'] for e in step['events'] if e['event']=='queue-updated' and not e['pending'])
    latencies.append(round((ready-click)*1000))
case('Live chat details','pass',{'clickToDetailsAppliedMs':latencies,'samples':2},['live-switch-menu.json'])
case('Live contact and filter menus','pass',{'menuOpened':True,'escapeRestoredInputs':True},['live-switch-menu.json','live-filter-close.json'])
assert switch[5]['events'][-1]['menuOpen']
assert any(e.get('menuOpen') for e in read('live-filter-close')[2]['events'])
assert not panel(read('live-filter-close')[7])['visible']
case('Live X button','pass',{'hiddenAfterTransition':True},['live-filter-close.json'])

slow=read('slow-chat-switch')
selected=composer_id(slow[4])
assert selected=='10000000-0000-4000-8000-000000000003'
case('Switch chats while details load','fail',{'clicked':'Launch planning','remainedSelected':'Interface review','delayMs':3000},['slow-chat-switch.json'])
typing=read('typing-during-details')[4]
assert panel(typing)['composer']['readOnly'] and panel(typing)['composer']['text']==''
case('Compose while details load','fail',{'readOnly':True,'requestedText':'E2E typing during loading','actualText':''},['typing-during-details.json'])

idle=read('idle-keyboard-search')
assert panel(idle[2])['composer']['text']=='Hyphen E2E — café 🎉'
case('Idle Unicode typing','pass',{'textMatched':True},['idle-keyboard-search.json'])
assert '\r' not in panel(idle[6])['composer']['text'] and '\n' not in panel(idle[6])['composer']['text']
case('Shift+Enter through cursor','cursor-compatibility-gap',{'newlineInserted':False,'reason':'Private key adapter sends WM_KEYDOWN/WM_KEYUP without translated WM_CHAR. Native physical-key behavior is not established by this result.'},['idle-keyboard-search.json'])
assert idle[9]['receipt']['result']['guard']['virtual_focus']==panel(idle[9])['search']['hwnd']
case('Ctrl+F through cursor','pass-with-cursor-limitation',{'searchReceivedPrivateFocus':True,'typingWithoutMovingPointerToSearchWasRejected':error(idle[11])},['idle-keyboard-search.json','search-via-cursor.json'])
assert panel(read('search-via-cursor')[2])['search']['text']=='Launch'
assert panel(read('slow-search')[4])['search']['text']=='Desktop' and panel(read('slow-search')[4])['composer']['readOnly']
case('Search during details load','pass',{'searchTextMatched':True,'filteredToDesktop':True},['slow-search.json'])

sent=json.loads((DIRECTORY/'fixture/sent.json').read_text(encoding='utf-8'))
assert len(sent)==1 and sent[0]['threadId'].endswith('000001') and sent[0]['text']=='Hyphen E2E — café 🎉second line'
assert panel(read('send-completion-add-menu')[0])['composer']['text']==''
case('Enter sends once to correct source','pass',{'syntheticDeliveredCount':1,'sourceId':sent[0]['threadId'],'draftClearedAfterSuccess':True},['send-enter-busy.json','fixture/sent.json','send-completion-add-menu.json'])
busy=read('send-enter-busy')
assert panel(busy[3])['composer']['readOnly'] and panel(busy[3])['composer']['text']==sent[0]['text']
assert composer_id(busy[5])==composer_id(busy[2])
case('Typing and switching while Send is pending','fail',{'newTypingIgnored':True,'chatSwitchIgnored':True,'delayMs':3000},['send-enter-busy.json'])

queued=json.loads((DIRECTORY/'fixture/messages.json').read_text(encoding='utf-8'))['entries']
assert len(queued)==2 and all(message['status']=='queued' for message in queued)
assert {message['sourceId'] for message in queued}=={'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'}
case('Queue and queue recovery after refusal','pass',{'queuedCount':2,'allSourcesMatched':True,'automaticDeliveryDisabledInFixture':True},['queue-message.json','draft-restored-queue-refusal.json','fixture/messages.json'])
refusal=read('writer-refusal-confirmed')[1]
assert panel(refusal)['composer']['text']=='E2E writer refusal keeps this draft'
assert 'draft is saved' in panel(refusal)['audit']['notice']
case('Active-writer refusal','pass',{'draftRetained':True,'deliveryNotClaimed':True,'noAdditionalSend':True},['writer-refusal-confirmed.json','fixture/sent.json'])
restored=read('draft-restored-queue-refusal')[0]
assert panel(restored)['composer']['text']=='E2E writer refusal keeps this draft'
case('Per-chat draft restoration','pass',{'desktopDraftRestored':True,'interfaceDraftStoredSeparately':True},['history-draft-return.json','draft-restored-queue-refusal.json'])

proof=read('focus-proof')
assert proof['focusWhileSearching']==proof['searchHwnd'] and proof['focusAfterDetails']==proof['composerHwnd'] and proof['pointerTargetAfterDetails']==proof['searchHwnd']
case('Preserve Search focus after details finish','fail',proof,['focus-during-load.json','focus-after-load.json','focus-proof.json'])
history=read('history-draft-return')
offsets=[e['conversationOffset'] for step in (history[5],history[6]) for e in step['events'] if e['event']=='ui-scroll']
case('Conversation arrow scrolling','pass-with-ux-issue',{'offsets':offsets,'pixelsPerPress':1,'observation':'Responded, but only moved one pixel per cursor key press.'},['history-draft-return.json'])
paging=read('focus-after-load')
assert paging[7]['events'][-1]['sidebarOffset']==5 and paging[10]['events'][-1]['sidebarOffset']==0
case('Sidebar paging','pass',{'offsetSequence':[0,5,0]},['focus-after-load.json'])

picker=read('image-picker-open')[-1]
cancel=read('picker-cancel-attempt')[-1]
assert error(picker)=='The native guard did not answer' and 'one root window' in error(cancel)
case('Image picker through protected cursor','cursor-compatibility-gap',{'dialogOpened':True,'openClickTimedOut':True,'cancelBlockedBySingleRootAdapter':True,'attachmentImportNotTested':True,'cleanup':'Identity-checked WM_CLOSE on own disposable dialog; not counted as an E2E Cancel pass.'},['image-picker-open.json','picker-timeout-evidence.json','picker-cancel-attempt.json'])

offline=panel(read('disconnected-draft')[2]);online=panel(read('reconnect-and-close')[0])
assert not offline['audit']['connected'] and not offline['audit']['canReply'] and not offline['composer']['readOnly']
assert online['audit']['connected'] and online['audit']['canReply'] and online['composer']['text']==offline['composer']['text']
case('Offline drafting and reconnect','pass',{'editableOffline':True,'sendDisabledOffline':True,'identicalDraftAfterReconnect':True},['disconnected-draft.json','reconnect-and-close.json'])
assert not panel(read('reconnect-and-close')[3])['visible']
case('Isolated X button','pass',{'hiddenAfterTransition':True},['reconnect-and-close.json'])

images=DIRECTORY/'screenshots';images.mkdir(exist_ok=True)
image_index=[]
for step in steps:
    source=step['receipt'].get('result',{}).get('screenshot_path')
    if source:
        target=images/(step['label']+'-'+str(step['step'])+'.png');shutil.copyfile(source,target)
        image_index.append({'file':str(target.relative_to(DIRECTORY)),'requestId':step['receipt']['request_id']})
processes=json.loads((DIRECTORY/'fixture/test-processes.json').read_text(encoding='utf-8-sig'))
k=C.WinDLL('kernel32');k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
k.CloseHandle.argtypes=[W.HANDLE]
k.GetExitCodeProcess.argtypes=[W.HANDLE,C.POINTER(W.DWORD)]
def alive(pid):
    handle=k.OpenProcess(0x1000,False,pid)
    if not handle:return False
    code=W.DWORD();queried=k.GetExitCodeProcess(handle,C.byref(code))
    k.CloseHandle(handle);return bool(queried and code.value==259)
runtime=json.loads((pathlib.Path(os.environ['HYPHEN_INSTALL_ROOT'])/'data/desktop/runtime.json').read_text(encoding='utf-8-sig'))
summary={'testedVersion':'0.6.8','exeSha256':processes['exeSha256'],'binaryUnchanged':hashlib.sha256(pathlib.Path(processes['exe']).read_bytes()).hexdigest().upper()==processes['exeSha256'],
    'platform':'Windows, primary 2560x1440 screen, 96 DPI','cursorSession':'e2317a75609d4f34b3005b00475b22a1',
    'transport':'Separate-cursor persistent worker, private_input_v2; read-only Win32 state and fixture files verify responses.',
    'cursorCommandsRecorded':len(steps),'cursorCommandErrors':[{'label':s['label'],'step':s['step'],'error':error(s)} for s in steps if not s['receipt'].get('ok')],
    'findings':tests,'screenshots':image_index,
    'cleanup':{'isolatedNativeExited':not alive(processes['panelPid']),'isolatedBackendExited':not alive(processes['backendPid']),'liveNativeRunning':alive(68052),'liveBackendRunning':alive(84684),'liveVersion':runtime.get('version'),'cursorWorkerRunning':alive(36552),'cursorRendererRunning':alive(40012),'cursorReturnedTo':[1592,1416],'heldInputReleased':True},
    'limitations':['Send/Queue/refusal use a deterministic synthetic Codex transport; no messages were sent to working chats.','The first writer-refusal attempt went to the synthetic Hyphen assistant after Escape returned from the chat; the confirmed source-checked refusal run is separate.','live-chat-visible.json predates correction of the readOnly observer; its readOnly flag is excluded. All subsequent records inspect ES_READONLY.','Cursor CLI wall time includes travel, Python startup and polling; it is not UI latency. Click-to-details values use native UI event timestamps.','Shift+Enter and image-picker failures are cursor compatibility results, not proof of failure with a physical keyboard/mouse.','No mouse wheel, drag/drop, right-click, IME, physical mixed-DPI/multi-monitor, Mac or iPhone pass.','Candidate 0.6.9 remains blocked by Windows Application Control and was not tested or installed in this pass.'],
    'verdict':'Normal interactions pass; pending-operation responsiveness and focus retention fail on installed 0.6.8.'}
assert summary['binaryUnchanged'] and all(summary['cleanup'][key] for key in ('isolatedNativeExited','isolatedBackendExited','liveNativeRunning','liveBackendRunning','cursorWorkerRunning','cursorRendererRunning'))
(DIRECTORY/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({'verdict':summary['verdict'],'cursorCommandsRecorded':len(steps),'screenshots':len(image_index),'liveChatDetailsMs':latencies,'cleanup':summary['cleanup']},indent=2))
