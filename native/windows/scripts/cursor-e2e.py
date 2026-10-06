"""Drive the existing separate-cursor worker; independently read Hyphen state.

Only cursor CLI commands provide input. Win32 calls below enumerate/read our
window and request the existing read-only audit report in an isolated test app.
"""
import argparse, ctypes as C, json, pathlib, subprocess, time, os, sys
from ctypes import wintypes as W

if not os.environ.get('HYPHEN_CURSOR_CLI'):
    raise SystemExit('Set HYPHEN_CURSOR_CLI to the existing separate-cursor agent_cli.py')
CURSOR = pathlib.Path(os.environ['HYPHEN_CURSOR_CLI'])
PYTHON = sys.executable
LOG = pathlib.Path(__file__).resolve().parents[1] / 'build/artifacts/native-hover.jsonl'
u = C.WinDLL('user32', use_last_error=True)
u.SendMessageTimeoutW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM, W.UINT, W.UINT, C.POINTER(C.c_size_t)]
u.SendMessageTimeoutW.restype = W.LPARAM
u.GetDlgItem.argtypes = [W.HWND, C.c_int]
u.GetDlgItem.restype = W.HWND
u.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
u.IsWindowVisible.argtypes = [W.HWND]
u.IsWindowEnabled.argtypes = [W.HWND]
u.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
u.GetWindowLongW.argtypes = [W.HWND, C.c_int]
u.GetWindowLongW.restype = C.c_long
u.EnumWindows.argtypes = [C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM), W.LPARAM]
u.EnumChildWindows.argtypes = [W.HWND,C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM),W.LPARAM]
u.GetDlgCtrlID.argtypes=[W.HWND];u.GetDlgCtrlID.restype=C.c_int

def send(hwnd, msg, wp=0, lp=0):
    result=C.c_size_t()
    if not u.SendMessageTimeoutW(hwnd, msg, wp, lp, 2, 1000, C.byref(result)):
        return None
    return result.value

def text(hwnd):
    buffer=C.create_unicode_buffer(32769)
    count=send(hwnd, 13, len(buffer), C.addressof(buffer))
    return buffer.value if count is not None else None

def snapshot(pid, audit):
    windows=[]
    @C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def visit(hwnd, _):
        owner=W.DWORD();u.GetWindowThreadProcessId(hwnd,C.byref(owner))
        cls=C.create_unicode_buffer(256);u.GetClassNameW(hwnd,cls,256)
        if owner.value==pid and (cls.value=='NativeHoverPanel' or (cls.value=='#32770' and u.IsWindowVisible(hwnd))):
            rect=W.RECT();u.GetWindowRect(hwnd,C.byref(rect))
            entry={'hwnd':hwnd,'class':cls.value,'visible':bool(u.IsWindowVisible(hwnd)), 'bounds':[rect.left,rect.top,rect.right,rect.bottom]}
            if cls.value=='#32770':
                entry['title']=text(hwnd);entry['controls']=[]
                @C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
                def control(child,unused):
                    child_pid=W.DWORD();u.GetWindowThreadProcessId(child,C.byref(child_pid))
                    name=C.create_unicode_buffer(256);u.GetClassNameW(child,name,256)
                    if child_pid.value==pid and name.value in ('Button','Edit') and u.IsWindowVisible(child):
                        box=W.RECT();u.GetWindowRect(child,C.byref(box))
                        entry['controls'].append({'hwnd':child,'id':u.GetDlgCtrlID(child),'class':name.value,'text':text(child),'enabled':bool(u.IsWindowEnabled(child)), 'bounds':[box.left,box.top,box.right,box.bottom]})
                    return True
                u.EnumChildWindows(hwnd,control,0)
                windows.append(entry);return True
            for control_id,name in [(201,'composer'),(202,'search')]:
                child=u.GetDlgItem(hwnd,control_id)
                if child:
                    entry[name]={'hwnd':child,'text':text(child),'visible':bool(u.IsWindowVisible(child)),'enabled':bool(u.IsWindowEnabled(child)), 'readOnly':bool(u.GetWindowLongW(child,-16)&0x800)}
                    bounds=W.RECT();u.GetWindowRect(child,C.byref(bounds))
                    entry[name]['bounds']=[bounds.left,bounds.top,bounds.right,bounds.bottom]
                    if name=='composer':
                        formatting=W.RECT();send(child,0xB2,0,C.addressof(formatting))  # EM_GETRECT
                        entry[name]['format']=[formatting.left,formatting.top,formatting.right,formatting.bottom]
                        entry[name]['lines']=send(child,0xBA)  # EM_GETLINECOUNT
                        selection=send(child,0xB0)  # EM_GETSEL; fields are limited to < 65536 UTF-16 units.
                        entry[name]['selection']=None if selection is None else [selection&0xFFFF,(selection>>16)&0xFFFF]
            if audit:
                send(hwnd,0x8000+215)
                try:entry['audit']=json.loads(pathlib.Path(audit).read_text(encoding='utf-8'))
                except (OSError,ValueError):pass
            windows.append(entry)
        return True
    u.EnumWindows(visit,0)
    return {'pid':pid,'windows':windows}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('directory');parser.add_argument('pid',type=int)
    parser.add_argument('label');parser.add_argument('actions',help='JSON array of cursor actions')
    parser.add_argument('--audit');parser.add_argument('--wait-ready',action='store_true');parser.add_argument('--require-composer');parser.add_argument('--quiet',action='store_true');args=parser.parse_args()
    directory=pathlib.Path(args.directory);directory.mkdir(parents=True,exist_ok=True)
    if args.wait_ready:
        if not args.audit:raise SystemExit('--wait-ready requires the isolated audit report')
        deadline=time.monotonic()+6
        while True:
            state=snapshot(args.pid,args.audit)
            if any(window.get('audit',{}).get('canDraft') for window in state['windows']):break
            if time.monotonic()>=deadline:raise SystemExit('Isolated composer did not become ready; no input sent')
            time.sleep(.1)
    if args.require_composer:
        state=snapshot(args.pid,args.audit)
        if not any(hit.get('action')=='addMenu' and args.require_composer in hit.get('key','').split('\n')[1:4] for window in state['windows'] for hit in window.get('audit',{}).get('hits',[])):
            raise SystemExit('Composer identity does not match; no input sent')
    actions=json.loads(args.actions);records=[]
    for index,action in enumerate(actions):
        offset=LOG.stat().st_size if LOG.exists() else 0
        before=snapshot(args.pid,args.audit);started=time.perf_counter()
        # The CLI resolves timeouts by request id. Never retry an input here.
        process=subprocess.run([PYTHON,str(CURSOR),json.dumps(action),'--timeout','45'],capture_output=True,text=True,encoding='utf-8',timeout=50)
        ended=time.perf_counter()
        try:receipt=json.loads(process.stdout)
        except ValueError:receipt={'ok':False,'stdout':process.stdout,'stderr':process.stderr}
        after=snapshot(args.pid,args.audit)
        events=[]
        if LOG.exists():
            with LOG.open('rb') as source:
                source.seek(offset)
                for line in source.read().decode('utf-8',errors='replace').splitlines():
                    try:
                        event=json.loads(line)
                        if event.get('pid')==args.pid or event.get('event')=='native.command':events.append(event)
                    except ValueError:pass
        record={'label':args.label,'step':index,'action':action,'cursorRoundTripMs':round((ended-started)*1000,2),'receipt':receipt,'before':before,'after':after,'events':events}
        records.append(record)
        output=directory/(args.label+'.json');output.write_text(json.dumps(records,indent=2),encoding='utf-8')
        compact=[]
        for window in after['windows']:
            item={k:v for k,v in window.items() if k!='audit'}
            if 'audit' in window:item['audit']={k:v for k,v in window['audit'].items() if k!='hits'}
            compact.append(item)
        brief={'label':args.label,'step':index,'action':action.get('action'),'ok':receipt.get('ok'),'request_id':receipt.get('request_id'),'screenshot':receipt.get('result',{}).get('screenshot_path'), 'error':receipt.get('error',receipt.get('result',{}).get('error'))}
        if not args.quiet:brief.update(windows=compact,events=[{k:e[k] for k in ('event','seconds','selected','pending','composerVisible','menuOpen','searchLength','conversationOffset','sidebarOffset') if k in e} for e in events])
        print(json.dumps(brief),flush=True)
        if not receipt.get('ok'):raise SystemExit(1)

if __name__=='__main__':main()
