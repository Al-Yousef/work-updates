"""Fixed private-input scenarios; no account, worker startup or OS input fallback."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

SOURCE = '10000000-0000-4000-8000-000000000001'
DRAFT = 'Synthetic QA draft Ω'


def worker(receipt, chat_id, session=None):
    result = receipt.get('result', {})
    if (receipt.get('ok') is not True or result.get('api_version') != 4 or
        result.get('owner', {}).get('chat_id') != chat_id or
        result.get('input_backend') != 'private_input_v2' or
        result.get('protected_input') is not True or result.get('busy') is not False or
        (session is not None and receipt.get('session') != session)):
        raise ValueError('Existing idle protected chat-owned worker required')
    return receipt['session']


def owned_window(receipt, pid, root):
    if receipt.get('ok') is not True:
        raise ValueError('Window discovery failed')
    rows = [row for row in receipt.get('result', {}).get('windows', [])
            if row.get('pid') == pid and row.get('root') == root]
    if len(rows) != 1 or rows[0].get('minimized') or rows[0].get('assigned_to'):
        raise ValueError('Exact owned native window unavailable')
    return rows[0]['id']


def main():
    if os.name != 'nt' or len(sys.argv) != 5:
        raise ValueError('Windows physical driver arguments required')
    directory, pid, revision, chat_id = pathlib.Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
    import ctypes as c
    from ctypes import wintypes as w
    # Reuse only this helper's read-only owned-window snapshot, never its generic
    # action runner or shared log. No global app data or other windows are saved.
    spec = importlib.util.spec_from_file_location('owned_native_snapshot', pathlib.Path(__file__).with_name('cursor-e2e.py'))
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    u, k = observer.u, c.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k.OpenProcess.restype = w.HANDLE
    k.WaitForSingleObject.argtypes = [w.HANDLE,w.DWORD]; k.WaitForSingleObject.restype = w.DWORD
    k.CloseHandle.argtypes = [w.HANDLE]
    u.GetForegroundWindow.restype = w.HWND
    u.GetCursorPos.argtypes = [c.POINTER(w.POINT)]
    u.ClientToScreen.argtypes = [w.HWND,c.POINTER(w.POINT)]
    handle = k.OpenProcess(0x101000,False,pid)
    if not handle: raise ValueError('Cannot retain owned native process handle')
    root = None
    audit = directory/'ux-state.json'
    checks, receipts = [], []
    cursor = os.environ['HYPHEN_CURSOR_CLI']
    session = None
    stop = threading.Event()
    samples = []
    observer_errors = []
    started = time.monotonic()

    def state():
        nonlocal root
        if k.WaitForSingleObject(handle,0) != 258:
            raise ValueError('Original native process exited; no replacement input')
        # Never accept the previous report when a hung window cannot refresh it.
        audit.unlink(missing_ok=True)
        panels = [item for item in observer.snapshot(pid,str(audit))['windows'] if item['class']=='NativeHoverPanel']
        if len(panels) != 1: raise ValueError('Owned panel unavailable')
        panel = panels[0]
        if 'audit' not in panel: raise ValueError('Fresh owned-window report unavailable')
        if root is not None and panel['hwnd'] != root: raise ValueError('Owned panel identity changed')
        root = panel['hwnd']
        return panel

    def wait(predicate, seconds=6):
        deadline = time.monotonic()+seconds
        while True:
            current = state()
            if predicate(current): return current
            if time.monotonic()>=deadline: raise ValueError('Owned state did not confirm the action')
            time.sleep(.05)

    def command(action, input_action=False):
        if input_action: state()
        # A timeout never replays input. The original accepted request remains
        # identifiable in this private report and is cancelled by ID if possible.
        completed = subprocess.run([sys.executable,cursor,'--chat-id',chat_id,
            action if isinstance(action,str) else json.dumps(action), '--timeout','10'],
            capture_output=True,text=True,encoding='utf-8',timeout=12)
        try: receipt = json.loads(completed.stdout)
        except ValueError: raise ValueError('Cursor receipt unavailable; no retry') from None
        receipts.append({key:receipt[key] for key in ('ok','request_id','session') if key in receipt})
        if receipt.get('ok') is not True or (session is not None and receipt.get('session') != session):
            if receipt.get('request_id') and receipt.get('session') == session:
                subprocess.run([sys.executable,cursor,'--chat-id',chat_id,'cancel',receipt['request_id'],'--timeout','5'],
                    capture_output=True,timeout=7)
            raise ValueError('Cursor action unconfirmed; no input replay')
        if input_action: state()
        return receipt

    def watch_desktop():
        while not stop.is_set():
            point = w.POINT()
            if not u.GetCursorPos(c.byref(point)):
                observer_errors.append('cursor_read_failed');return
            samples.append((time.monotonic(),int(u.GetForegroundWindow() or 0),point.x,point.y))
            stop.wait(.005)

    def click_point(x,y, unchanged):
        command({'action':'move','x':x,'y':y,'duration_ms':120},True)
        if not unchanged(state()): raise ValueError('Paint target changed during movement; no click replay')
        command({'action':'click','backend':'private_input','expected_root':root},True)

    def click_hit(action, source=None):
        current = state()
        hits = [hit for hit in current.get('audit',{}).get('hits',[])
                if hit['action']==action and hit['enabled'] and (source is None or hit['sourceId']==source)]
        if len(hits)!=1: raise ValueError('Exact enabled paint target required')
        box = hits[0]['box']; dpi = current['audit']['dpi']
        point = w.POINT(round((box[0]+box[2])/2*dpi/96),round((box[1]+box[3])/2*dpi/96))
        if not u.ClientToScreen(root,c.byref(point)): raise ValueError('Owned geometry unavailable')
        key, selected, selected_source = hits[0]['key'], current['audit']['selected'], current['audit']['source']
        def unchanged(panel):
            value = panel.get('audit',{})
            matches = [hit for hit in value.get('hits',[]) if hit.get('key')==key and hit.get('enabled')]
            return (value.get('selected')==selected and value.get('source')==selected_source and
                    len(matches)==1 and matches[0]['box']==box and value.get('dpi')==dpi)
        click_point(point.x,point.y,unchanged)

    passed = False
    failure = None
    watcher = None
    released = False
    sent = []
    try:
        current = wait(lambda panel:panel['visible'] and panel.get('audit',{}).get('connected'))
        session = worker(command('info'),chat_id)
        selection = owned_window(command('windows'),pid,root)
        route = command('app_capabilities '+selection)['result']
        if route.get('native_guard_attempt_eligible') is not True or route.get('foreground_fallback') is not False:
            raise ValueError('Protected route unavailable; no fallback')
        watcher = threading.Thread(target=watch_desktop,daemon=True);watcher.start()
        command('move_window '+selection+' assigned')
        worker(command('info'),chat_id,session)
        click_hit('card',SOURCE)
        wait(lambda panel:panel.get('audit',{}).get('source')==SOURCE and panel['audit'].get('canDraft'))
        checks.append('source_selection')
        current = state(); editor = current['composer']
        if not editor['visible'] or not editor['enabled'] or editor['readOnly'] or editor['text'] != '':
            raise ValueError('Empty readable owned composer required')
        box = editor['bounds']
        click_point((box[0]+box[2])//2,(box[1]+box[3])//2,
            lambda panel:panel.get('audit',{}).get('source')==SOURCE and
            panel.get('composer',{}).get('hwnd')==editor['hwnd'] and
            panel['composer']['bounds']==box and panel['composer']['text']=='')
        wait(lambda panel:panel.get('audit',{}).get('composerFocused') is True)
        command({'action':'type_verified','text':DRAFT},True)
        wait(lambda panel:panel['composer']['text']==DRAFT and panel['audit']['source']==SOURCE)
        checks.append('unicode_draft_readback')
        click_hit('back');wait(lambda panel:not panel.get('audit',{}).get('selected'))
        click_hit('card',SOURCE)
        wait(lambda panel:panel.get('audit',{}).get('source')==SOURCE and panel.get('composer',{}).get('text')==DRAFT)
        checks.append('draft_preserved_after_navigation')
        click_hit('send')
        wait(lambda panel:panel.get('composer',{}).get('text')=='' and not panel['audit']['pending'])
        sent = json.loads((directory/'fixture'/'sent.json').read_text(encoding='utf-8'))
        if sent != [{'threadId':SOURCE,'text':DRAFT,'images':[]}]: raise ValueError('Synthetic delivery identity or count changed')
        checks.append('exactly_once_synthetic_delivery')
        click_hit('close');wait(lambda panel:panel['visible'] is False)
        checks.append('panel_hidden')
        command('release');released=True;checks.append('owned_input_released')
        passed = True
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired):
        failure = 'private_input_or_independent_readback_unverified'
    finally:
        if session and not released:
            try: command('release');released=True
            except (OSError,ValueError,KeyError,subprocess.TimeoutExpired): passed=False
        if watcher:
            stop.set();watcher.join(timeout=1)
        alive = k.WaitForSingleObject(handle,0)==258
        k.CloseHandle(handle)
        gaps = [(b[0]-a[0])*1000 for a,b in zip(samples,samples[1:])]
        unchanged = bool(samples) and not observer_errors and all(row[1:]==samples[0][1:] for row in samples)
        desktop = {'independentOfTargetAndCursorProcesses':True,'unchanged':unchanged,
            'samples':len(samples),'durationMs':round((samples[-1][0]-samples[0][0])*1000,2) if samples else 0,
            'maximumGapMs':round(max(gaps,default=1000),2),'betweenSamplesUnverified':True}
        passed = passed and alive and unchanged and len(samples)>=20 and max(gaps,default=1000)<=50
        report = {'schema':1,'sourceRevision':revision,'chatId':chat_id,'nativePid':pid,'passed':passed,
            'accountsUsed':0,'modelCalls':0,'installedAppChanged':False,
            'evidence':'separate_cursor_owned_synthetic_native_controls','inputBackend':'private_input_v2',
            'processIdentityPreserved':alive,'checks':checks,'sent':sent,'desktop':desktop,
            'receipts':receipts,'failure':failure,'durationMs':round((time.monotonic()-started)*1000)}
        (directory/'physical-input.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
