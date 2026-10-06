"""Reversible redirection probe, confined to an owned isolated test app."""
import ctypes as C, json, pathlib, sys, time
from ctypes import wintypes as W
from PIL import ImageGrab

record_path=pathlib.Path(sys.argv[1]).resolve()
record=json.loads(record_path.read_text(encoding='utf-8-sig'))
fixture=json.loads((pathlib.Path(record['fixture'])/'fixture-ready.json').read_text())
if not fixture.get('isolated') or 'artifacts' not in record_path.parts:
    raise SystemExit('An isolated fixture is required')
u=C.WinDLL('user32',use_last_error=True); k=C.WinDLL('kernel32',use_last_error=True)
u.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)]
u.GetDlgItem.argtypes=[W.HWND,C.c_int];u.GetDlgItem.restype=W.HWND
u.GetWindowLongPtrW.argtypes=[W.HWND,C.c_int];u.GetWindowLongPtrW.restype=C.c_ssize_t
u.SetWindowLongPtrW.argtypes=[W.HWND,C.c_int,C.c_ssize_t];u.SetWindowLongPtrW.restype=C.c_ssize_t
u.SetLayeredWindowAttributes.argtypes=[W.HWND,W.DWORD,C.c_byte,W.DWORD]
u.SetWindowPos.argtypes=[W.HWND,W.HWND,C.c_int,C.c_int,C.c_int,C.c_int,W.UINT]
u.GetWindowRect.argtypes=[W.HWND,C.POINTER(W.RECT)]
u.RedrawWindow.argtypes=[W.HWND,C.c_void_p,W.HANDLE,W.UINT]
k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
k.QueryFullProcessImageNameW.argtypes=[W.HANDLE,W.DWORD,W.LPWSTR,C.POINTER(W.DWORD)]
k.CloseHandle.argtypes=[W.HANDLE]
process=k.OpenProcess(0x1000,False,record['panelPid'])
try:
    path=C.create_unicode_buffer(32768);size=W.DWORD(len(path))
    if not process or not k.QueryFullProcessImageNameW(process,0,path,C.byref(size)) or pathlib.Path(path.value)!=pathlib.Path(record['exe']):
        raise SystemExit('Test process identity changed')
finally:
    if process:k.CloseHandle(process)
panels=[]
@C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
def visit(hwnd,_):
    owner=W.DWORD();u.GetWindowThreadProcessId(hwnd,C.byref(owner))
    name=C.create_unicode_buffer(256);u.GetClassNameW(hwnd,name,256)
    if owner.value==record['panelPid'] and name.value=='NativeHoverPanel':panels.append(hwnd)
    return True
u.EnumWindows(visit,0)
if len(panels)!=1:raise SystemExit('Test panel identity is ambiguous')
panel=panels[0];fields=[u.GetDlgItem(panel,n) for n in (201,202)]
original=[u.GetWindowLongPtrW(field,-20) for field in fields]
box=W.RECT();u.GetWindowRect(panel,C.byref(box));bounds=(box.left,box.top,box.right,box.bottom)
directory=record_path.parent
ImageGrab.grab(bbox=bounds).save(directory/'redirection-before.png')
try:
    for field,style in zip(fields,original):
        u.SetWindowLongPtrW(field,-20,style|0x80000)
        if not u.SetLayeredWindowAttributes(field,0,255,2):raise C.WinError(C.get_last_error())
        u.SetWindowPos(field,None,0,0,0,0,0x37)
        u.RedrawWindow(field,None,None,0x185)
    C.WinDLL('dwmapi').DwmFlush();time.sleep(.2)
    ImageGrab.grab(bbox=bounds).save(directory/'redirection-layered.png')
    print(json.dumps({'pid':record['panelPid'],'layeredPreview':str(directory/'redirection-layered.png'),'restoresOriginalStyles':True}))
finally:
    for field,style in zip(fields,original):
        u.SetWindowLongPtrW(field,-20,style);u.SetWindowPos(field,None,0,0,0,0,0x37);u.RedrawWindow(field,None,None,0x185)
