"""Assert independent observations for the cursor fixes; no input or cleanup."""
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
load=lambda name:json.loads((root/name).read_text(encoding='utf-8-sig'))
panel=lambda record:next(w for w in record['after']['windows'] if w['class']=='NativeHoverPanel')
dialogs=lambda record:[w for w in record['after']['windows'] if w['class']=='#32770']
keyboard=load('newline-and-backspace.json')
assert panel(keyboard[4])['composer']['text']=='Line one\r\n'
assert panel(keyboard[7])['composer']['text']=='Line one\r\nLine tw'
cancel=load('picker-cancel.json')[-1]
assert not dialogs(cancel) and panel(cancel)['composer']['text']=='Line one\r\nLine tw'
opening=load('picker-open.json')[-1];reopening=load('picker-reopened-proof.json')[-1]
assert len(dialogs(opening))==len(dialogs(reopening))==1
assert dialogs(opening)[0]['hwnd']!=dialogs(reopening)[0]['hwnd']
imported=load('picker-import-correct-path.json')[-1]
assert not dialogs(imported)
assert any(h['action']=='removeImage' for h in panel(imported)['audit']['hits'])
drafts=load('fixture/drafts.json');attachment=drafts['attachments']['@hyphen'][0]
digest=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert digest(attachment['path'])==digest(root/'fixture/fixture-image.png')
sent=load('fixture/sent.json')
assert sent==[{'threadId':'10000000-0000-4000-8000-000000000001','text':'Cursor regression verified','images':[]}]
installed=load('installed-keyboard.json')[-1]
assert panel(installed)['composer']['text']=='Installed line\r\nSecond'
gap=load('installed-modal-gap-and-cancel.json')
assert all(r['receipt']['ok'] for r in gap)
assert gap[0]['receipt']['result']['arrived'] and gap[0]['receipt']['result']['display_only']
assert not dialogs(gap[-1]) and panel(gap[-1])['composer']['text']=='Installed line\r\nSecond'
hide=load('installed-hide-and-release.json')
assert not panel(hide[2])['visible']
assert hide[3]['receipt']['ok'] and hide[4]['receipt']['result']['arrived']
records=[]
for path in sorted(root.glob('*.json')):
    if path.name in ('summary.json','ux-state.json','test-processes.json','cleanup.json'):continue
    data=json.loads(path.read_text(encoding='utf-8-sig'))
    if isinstance(data,list):records.extend(data)
assert records and all(r['receipt']['ok'] for r in records)
guards=[r['receipt']['result'].get('guard') for r in records if r['receipt']['result'].get('guard')]
assert guards and all(g['modes']==25 and g['hook_count']==25 for g in guards)
screenshots=[r['receipt']['result']['screenshot_path'] for r in records if r['receipt']['result'].get('screenshot_path')]
assert all(pathlib.Path(path).is_file() for path in screenshots)
desktop=[r['receipt']['result'] for r in records if 'desktop_before' in r['receipt']['result']]
summary={'cursorFixesVerified':True,'cursorCommands':len(records),'captures':len(screenshots),
         'hyphenExe':load('test-processes.json')['exeSha256'],'hyphenVersion':'0.6.8',
         'scope':'Persistent separate cursor, disposable Hyphen process, synthetic backend; installed cursor guard, unchanged Hyphen executable',
         'newlinesAndBackspace':True,'pickerCancelAndReopen':True,'realImageImportMatchesFixture':True,
         'nestedDialogAndDesktopGap':True,'installedWorkerRerun':True,'directMessages':len(sent),'realChatsMessaged':0,
         'xHidesPanel':True,'heldInputReleased':True,
         'beforeAfterRealPointerEqual':all(r['real_cursor_unchanged'] for r in desktop),
         'beforeAfterForegroundEqual':all(r['foreground_unchanged'] for r in desktop),
         'transientGlobalFocusMonitoring':False,
         'nativeHyphen069Installed':False,'nativeHyphen069Block':'Windows application-control signing policy',
         'limitations':['Hyphen 0.6.9 GUI remains blocked','No signed-in Codex delivery','No physical mixed DPI or mobile testing','No new independent transient-focus observer'],
         'testRecovery':'The first import used forward slashes; the owned dialog rejected that test path. Correcting to Windows separators imported successfully.'}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
