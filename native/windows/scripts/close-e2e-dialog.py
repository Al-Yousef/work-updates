"""Cleanup only: close a verified dialog belonging to our disposable test process."""
import ctypes as C, json, pathlib, sys
from ctypes import wintypes as W
record=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
pid=int(record['panelPid']);trigger_mode=sys.argv[2]=='--panel';hwnd=0 if trigger_mode else int(sys.argv[2])
u=C.WinDLL('user32',use_last_error=True);k=C.WinDLL('kernel32',use_last_error=True)
u.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)]
u.GetClassNameW.argtypes=[W.HWND,W.LPWSTR,C.c_int]
u.GetWindowTextW.argtypes=[W.HWND,W.LPWSTR,C.c_int]
u.PostMessageW.argtypes=[W.HWND,W.UINT,W.WPARAM,W.LPARAM]
k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
k.QueryFullProcessImageNameW.argtypes=[W.HANDLE,W.DWORD,W.LPWSTR,C.POINTER(W.DWORD)]
k.CloseHandle.argtypes=[W.HANDLE]
if trigger_mode:
    matches=[]
    @C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
    def visit(window,_):
        owner=W.DWORD();u.GetWindowThreadProcessId(window,C.byref(owner))
        cls=C.create_unicode_buffer(256);u.GetClassNameW(window,cls,256)
        if owner.value==pid and cls.value=='NativeHoverTrigger':matches.append(window)
        return True
    u.EnumWindows(visit,0)
    if len(matches)!=1:raise SystemExit('Disposable trigger identity is ambiguous; left unchanged')
    hwnd=matches[0]
owner=W.DWORD();u.GetWindowThreadProcessId(hwnd,C.byref(owner))
cls=C.create_unicode_buffer(256);title=C.create_unicode_buffer(256)
u.GetClassNameW(hwnd,cls,256);u.GetWindowTextW(hwnd,title,256)
process=k.OpenProcess(0x1000,False,pid)
try:
    path=C.create_unicode_buffer(32768);size=W.DWORD(len(path))
    if not process or not k.QueryFullProcessImageNameW(process,0,path,C.byref(size)):raise SystemExit('Could not verify test process')
    expected_class,expected_title=('NativeHoverTrigger','Native Hover Trigger') if trigger_mode else ('#32770','Attach images')
    if owner.value!=pid or pathlib.Path(path.value)!=pathlib.Path(record['exe']) or cls.value!=expected_class or title.value!=expected_title:raise SystemExit('Disposable window identity mismatch; left unchanged')
    if not u.PostMessageW(hwnd,0x10,0,0):raise SystemExit('Cleanup close could not be posted')
    print(json.dumps({'cleanupOnly':True,'pid':pid,'dialog':hwnd,'title':title.value,'postedClose':True}))
finally:
    if process:k.CloseHandle(process)
