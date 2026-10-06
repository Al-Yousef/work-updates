#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <filesystem>
#include <fstream>
#include "protocol.h"
#include "profile.h"
#include "routing.h"
#include "vendor/minhook/include/MinHook.h"

namespace {
HINSTANCE self=nullptr;
std::atomic<DWORD> state{0}, flights{0};
std::atomic<bool> connected{false}, weatherInside{false};
std::atomic<unsigned> hoverSeen{0},clickSeen{0},weatherClicks{0},leaveSeen{0};
HANDLE stopEvent=nullptr, panelProcess=nullptr;
taskbar::Endpoint endpoint{};
bool hooksCreated=false;
using Hover=void(WINAPI*)(void*);
using Click=void(WINAPI*)(void*,IInspectable* const&,IInspectable* const&);
using Leave=void(WINAPI*)(void*,IInspectable* const&);
Hover originalHover=nullptr;
Click originalTaskbarClick=nullptr;
Leave originalLeave=nullptr;
struct Flight {Flight(){++flights;} ~Flight(){--flights;}};

bool post(taskbar::Command command) noexcept {
    // No IPC wait, disk work, rendering, or mouse interception on Explorer's UI thread.
    if(!connected.load(std::memory_order_acquire) || !panelProcess || WaitForSingleObject(panelProcess,0)!=WAIT_TIMEOUT)return false;
    const auto window=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(endpoint.window));
    return PostMessageW(window,taskbar::message,endpoint.cookie,static_cast<LPARAM>(command))!=0;
}
void WINAPI hoverHook(void* object) {
    Flight flight;
    ++hoverSeen;
    if(post(taskbar::Command::Hover)) {weatherInside=true; return;}
    originalHover(object);
}
void routeClick(Click original,void* object,IInspectable* const& sender,IInspectable* const& arguments) {
    ++clickSeen;
    if(connected.load(std::memory_order_acquire) && taskbar::weatherSender(sender) && post(taskbar::Command::Click)) {
        ++weatherClicks; weatherInside=true; return;
    }
    original(object,sender,arguments);
}
void WINAPI taskbarClickHook(void* object,IInspectable* const& sender,IInspectable* const& arguments) {
    Flight flight; routeClick(originalTaskbarClick,object,sender,arguments);
}
void WINAPI leaveHook(void* object,IInspectable* const& arguments) {
    Flight flight;
    originalLeave(object,arguments); // Preserve Windows' pointer and visual cleanup.
    // This shared handler is observed only after our weather invoke. It does not
    // consume leave events or assume private C++/WinRT implementation offsets.
    if(weatherInside.exchange(false))post(taskbar::Command::Leave);
    ++leaveSeen;
}
std::filesystem::path ownPath() {
    wchar_t path[32768]{}; GetModuleFileNameW(self,path,32768); return path;
}
void report(const char* event,DWORD detail=0) {
    std::ofstream out(ownPath().parent_path()/L"artifacts/taskbar-adapter.jsonl",std::ios::app);
    out<<"{\"event\":\""<<event<<"\",\"pid\":"<<GetCurrentProcessId()<<",\"detail\":"<<detail<<"}\n";
}
bool connectPanel() {
    if(!taskbar::readEndpoint(taskbar::endpointPath(ownPath()),endpoint))return false;
    const HWND window=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(endpoint.window));
    DWORD pid=0; GetWindowThreadProcessId(window,&pid);
    if(pid!=endpoint.pid)return false;
    panelProcess=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(!panelProcess)return false;
    wchar_t path[32768]{}; DWORD size=32768;
    const auto expected=(ownPath().parent_path()/L"Native Hover.exe").wstring();
    if(!QueryFullProcessImageNameW(panelProcess,0,path,&size) || _wcsicmp(path,expected.c_str()))return false;
    DWORD_PTR acknowledgement=0;
    return SendMessageTimeoutW(window,taskbar::message,endpoint.cookie,static_cast<LPARAM>(taskbar::Command::Hello),
        SMTO_ABORTIFHUNG|SMTO_BLOCK,2000,&acknowledgement) && acknowledgement==1;
}
DWORD WINAPI worker(void*) {
    HMODULE pinned=nullptr;
    // Hook callbacks and trampolines must remain valid even if a suspended thread
    // resumes late. Disabled adapters remain resident until Explorer exits.
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&worker),&pinned);
    CoInitializeEx(nullptr,COINIT_MULTITHREADED);
    bool installed=false;
    const HMODULE taskbar=GetModuleHandleW(L"Taskbar.View.dll");
    if(!taskbar::validateLoaded(taskbar)) {report("profile-refused"); goto finish;}
    if(!connectPanel()) {report("panel-refused"); goto finish;}
    if(!hooksCreated) {
        if(MH_Initialize()!=MH_OK) {report("minhook-init-failed"); goto finish;}
        const auto base=reinterpret_cast<unsigned char*>(taskbar);
        void* callbacks[]={reinterpret_cast<void*>(&hoverHook),reinterpret_cast<void*>(&taskbarClickHook),reinterpret_cast<void*>(&leaveHook)};
        void** originals[]={reinterpret_cast<void**>(&originalHover),reinterpret_cast<void**>(&originalTaskbarClick),
            reinterpret_cast<void**>(&originalLeave)};
        for(unsigned i=0;i<3;++i) {
            const auto result=MH_CreateHook(base+taskbar::sites[i].rva,callbacks[i],originals[i]);
            if(result!=MH_OK) {report("create-hook-failed",result); MH_Uninitialize(); goto finish;}
        }
        hooksCreated=true;
    }
    {
        const auto result=MH_EnableHook(MH_ALL_HOOKS);
        if(result!=MH_OK) {report("enable-hook-failed",result); MH_DisableHook(MH_ALL_HOOKS); goto finish;}
    }
    installed=true; hoverSeen=0; clickSeen=0; weatherClicks=0; leaveSeen=0;
    connected.store(true,std::memory_order_release);
    if(!post(taskbar::Command::Ready)) {report("ready-post-failed"); goto finish;}
    state=2; report("attached");
    {
        const HANDLE waiters[]={stopEvent,panelProcess};
        WaitForMultipleObjects(2,waiters,FALSE,INFINITE); // No idle polling or heartbeat.
    }
finish:
    connected.store(false,std::memory_order_release); weatherInside=false;
    if(installed) {
        const auto result=MH_DisableHook(MH_ALL_HOOKS);
        // Never free executable trampolines. A disable failure still passes every
        // command to the original handler, with the module pinned for safety.
        report(result==MH_OK?"restored":"disable-failed",result);
    }
    while(flights.load())Sleep(1);
    if(endpoint.window && endpoint.cookie)
        PostMessageW(reinterpret_cast<HWND>(static_cast<std::uintptr_t>(endpoint.window)),taskbar::message,endpoint.cookie,
            static_cast<LPARAM>(installed?taskbar::Command::Stopped:taskbar::Command::Failed));
    if(panelProcess) {CloseHandle(panelProcess); panelProcess=nullptr;}
    CoUninitialize(); state=installed?0:4; return 0;
}
}
extern "C" __declspec(dllexport) DWORD WINAPI AdapterStart(void*) {
    DWORD previous=state.load();
    if(previous!=0 && previous!=4)return previous;
    if(!state.compare_exchange_strong(previous,1))return state.load();
    if(!stopEvent)stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if(!stopEvent) {state=4; return 4;}
    ResetEvent(stopEvent);
    const HANDLE thread=CreateThread(nullptr,0,worker,nullptr,0,nullptr);
    if(!thread) {state=4; return 4;}
    CloseHandle(thread); return 1;
}
extern "C" __declspec(dllexport) DWORD WINAPI AdapterStop(void*) {
    connected.store(false,std::memory_order_release);
    if(stopEvent)SetEvent(stopEvent);
    DWORD failed=4; state.compare_exchange_strong(failed,0);
    return state.load();
}
extern "C" __declspec(dllexport) DWORD WINAPI AdapterStatus(void*) {return state.load();}
extern "C" __declspec(dllexport) DWORD WINAPI AdapterStats(void*) {
    return ((hoverSeen.load()&255)<<24)|((clickSeen.load()&255)<<16)|((weatherClicks.load()&255)<<8)|(leaveSeen.load()&255);
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,void*) {
    if(reason==DLL_PROCESS_ATTACH) {self=instance; DisableThreadLibraryCalls(instance);}
    return TRUE;
}
