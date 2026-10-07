#define UNICODE
#define _UNICODE
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NOMINMAX
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include "../taskbar-adapter/protocol.h"
#include "../taskbar-adapter/profile.h"
namespace {
unsigned checks=0; DWORD targetPid=0; HWND panel=nullptr;
void check(bool condition,const char* label) {++checks; if(!condition)throw std::runtime_error(label);}
BOOL CALLBACK findPanel(HWND window,LPARAM) {
    DWORD pid=0; GetWindowThreadProcessId(window,&pid); wchar_t name[128]{}; GetClassNameW(window,name,128);
    if(pid==targetPid && !wcscmp(name,L"NativeHoverPanel"))panel=window;
    return TRUE;
}
LRESULT command(const taskbar::Endpoint& endpoint,taskbar::Command action) {
    DWORD_PTR result=0;
    const auto window=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(endpoint.window));
    check(SendMessageTimeoutW(window,taskbar::message,endpoint.cookie,static_cast<LPARAM>(action),SMTO_ABORTIFHUNG,2000,&result)!=0,"Panel message must complete");
    return result;
}
}
int main() {
    PROCESS_INFORMATION process{};
    try {
        wchar_t own[32768]{}; GetModuleFileNameW(nullptr,own,32768);
        const auto executable=std::filesystem::path(own).parent_path()/L"Native Hover.exe";
        const HMODULE adapter=LoadLibraryW((executable.parent_path()/taskbar::adapterFilename).c_str());
        check(adapter!=nullptr,"Load actual adapter DLL only into this test process");
        using Control=DWORD(WINAPI*)(void*);
        const auto start=reinterpret_cast<Control>(GetProcAddress(adapter,"AdapterStart"));
        const auto status=reinterpret_cast<Control>(GetProcAddress(adapter,"AdapterStatus"));
        const auto stop=reinterpret_cast<Control>(GetProcAddress(adapter,"AdapterStop"));
        check(start && status && stop,"Actual DLL control exports exist");
        check(start(nullptr)==1,"Start isolated DLL worker");
        for(int i=0;i<40 && status(nullptr)==1;++i)Sleep(25);
        check(status(nullptr)==4,"Actual DLL refuses host without matching Taskbar module");
        check(stop(nullptr)==0,"Failed attachment can stop cleanly");
        std::wstring launch=L"\""+executable.wstring()+L"\" --standalone --taskbar-adapter --isolated-session";
        STARTUPINFOW startup{}; startup.cb=sizeof(startup); startup.dwFlags=STARTF_USESHOWWINDOW; startup.wShowWindow=SW_HIDE;
        check(CreateProcessW(executable.c_str(),launch.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&process)!=0,"Start own isolated native panel");
        targetPid=process.dwProcessId; CloseHandle(process.hThread);
        taskbar::Endpoint endpoint;
        bool ready=false;
        for(int i=0;i<80;++i) {
            ready=taskbar::readEndpoint(taskbar::endpointPath(executable),endpoint) && endpoint.pid==targetPid;
            if(ready)break;
            if(WaitForSingleObject(process.hProcess,0)!=WAIT_TIMEOUT)break;
            Sleep(50);
        }
        check(ready,"Panel publishes a fresh endpoint");
        EnumWindows(findPanel,0); check(panel!=nullptr,"Find own panel");
        const HWND control=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(endpoint.window));
        check(!IsWindowVisible(control),"Adapter control window stays hidden");
        check(!(GetWindowLongPtrW(control,GWL_EXSTYLE)&WS_EX_LAYERED),"No layered hotspot overlay");
        check(command(endpoint,taskbar::Command::Hello)==1,"Fresh hello succeeds");
        auto forged=endpoint; forged.cookie^=1;
        check(command(forged,taskbar::Command::Hover)==0 && !IsWindowVisible(panel),"Invalid session cannot reveal panel");
        check(command(endpoint,taskbar::Command::Ready)==1,"Adapter ready acknowledged");
        DWORD_PTR restartResult=0;
        check(SendMessageTimeoutW(control,RegisterWindowMessageW(L"TaskbarCreated"),0,0,SMTO_ABORTIFHUNG,2000,&restartResult)!=0,"Isolated taskbar restart message completes");
        check(command(endpoint,taskbar::Command::Hover)==1,"Hover routed to real panel"); Sleep(380);
        check(IsWindowVisible(panel),"Hover reveals real native window");
        check(command(endpoint,taskbar::Command::Click)==1,"Click pins real panel");
        check(command(endpoint,taskbar::Command::Leave)==1,"Weather leave observed"); Sleep(380);
        check(IsWindowVisible(panel),"Pinned panel survives leave");
        check(command(endpoint,taskbar::Command::Click)==1,"Second click hides"); Sleep(380);
        check(!IsWindowVisible(panel),"Second click hides real window");
        check(command(endpoint,taskbar::Command::Leave)==1,"Leave clears dismissal suppression");
        check(command(endpoint,taskbar::Command::Hover)==1,"Next hover reveals"); Sleep(380);
        SendMessageW(panel,WM_CLOSE,0,0); Sleep(380);
        check(!IsWindowVisible(panel),"Panel X close command dismisses");
        check(command(endpoint,taskbar::Command::Leave)==1,"Pointer exit clears weather state");
        check(command(endpoint,taskbar::Command::Hover)==1,"Reopen after X"); Sleep(380);
        SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0); Sleep(380);
        check(!IsWindowVisible(panel),"Escape dismisses");
        check(command(endpoint,taskbar::Command::Stopped)==1&&WaitForSingleObject(process.hProcess,0)==WAIT_TIMEOUT,"Stopped adapter leaves the queue and tray available");
        check(command(endpoint,taskbar::Command::Failed)==1&&command(endpoint,taskbar::Command::Hello)==1,"Failed adapter leaves the native control responsive");
        PostMessageW(control,WM_CLOSE,0,0);
        check(WaitForSingleObject(process.hProcess,3000)==WAIT_OBJECT_0,"Own native app exits gracefully");
        DWORD exit=1; check(GetExitCodeProcess(process.hProcess,&exit)!=0,"Read native child exit status");
        if(exit)std::cerr<<"Native child exit: 0x"<<std::hex<<exit<<std::dec<<"\n";
        check(exit==0,"Graceful native exit returns success");
        check(!std::filesystem::exists(taskbar::endpointPath(executable)),"Native exit removes session descriptor");
        std::ifstream log(executable.parent_path()/L"artifacts/native-hover.jsonl");
        std::string trace,line; const std::string pidField="\"pid\":"+std::to_string(targetPid);
        while(std::getline(log,line)) {
            const auto pidAt=line.find(pidField);
            if(pidAt!=std::string::npos && pidAt+pidField.size()<line.size() && (line[pidAt+pidField.size()]==',' || line[pidAt+pidField.size()]=='}'))trace+=line+'\n';
        }
        check(!trace.empty(),"Read trace from this isolated app only");
        check(trace.find("\"weatherGuard\":true")==std::string::npos && trace.find("\"triggerVisible\":true")==std::string::npos,"Runtime never enabled global hook or visible trigger");
        check(trace.find("\"adapterAutoAttach\":true")==std::string::npos&&trace.find("\"event\":\"explorer-restarted\"")==std::string::npos,"Isolated app cannot attach to Explorer after the taskbar restart message");
        CloseHandle(process.hProcess);process={};panel=nullptr;
        launch+=L" --no-auto-attach";
        check(CreateProcessW(executable.c_str(),launch.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&process)!=0,"Start only a fresh owned replacement panel with attachment disabled");
        targetPid=process.dwProcessId;CloseHandle(process.hThread);taskbar::Endpoint replacement{};ready=false;
        for(int i=0;i<80;++i){ready=taskbar::readEndpoint(taskbar::endpointPath(executable),replacement)&&replacement.pid==targetPid;if(ready||WaitForSingleObject(process.hProcess,0)!=WAIT_TIMEOUT)break;Sleep(50);}
        check(ready&&replacement.cookie!=endpoint.cookie,"Replacement panel publishes a different session");EnumWindows(findPanel,0);check(panel!=nullptr,"Find only the replacement panel");
        auto obsolete=replacement;obsolete.cookie=endpoint.cookie;
        check(command(obsolete,taskbar::Command::Hover)==0&&!IsWindowVisible(panel),"Obsolete session cannot reveal the replacement panel");
        check(command(replacement,taskbar::Command::Hello)==1,"Fresh replacement session remains responsive");
        const HWND replacementControl=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(replacement.window));
        check(SendMessageTimeoutW(replacementControl,RegisterWindowMessageW(L"TaskbarCreated"),0,0,SMTO_ABORTIFHUNG,2000,&restartResult)!=0,"Replacement no-auto-attach restart message completes");
        PostMessageW(replacementControl,WM_CLOSE,0,0);check(WaitForSingleObject(process.hProcess,3000)==WAIT_OBJECT_0,"Replacement exits normally without forced termination");
        check(GetExitCodeProcess(process.hProcess,&exit)&&exit==0,"Replacement returns successful shutdown");
        check(!std::filesystem::exists(taskbar::endpointPath(executable)),"Replacement removes only its own descriptor");
        std::ifstream replacementLog(executable.parent_path()/L"artifacts/native-hover.jsonl");std::string replacementTrace;const std::string replacementPid="\"pid\":"+std::to_string(targetPid);
        while(std::getline(replacementLog,line)){const auto at=line.find(replacementPid);if(at!=std::string::npos&&at+replacementPid.size()<line.size()&&(line[at+replacementPid.size()]==','||line[at+replacementPid.size()]=='}'))replacementTrace+=line+'\n';}
        check(!replacementTrace.empty()&&replacementTrace.find("\"adapterAutoAttach\":true")==std::string::npos&&replacementTrace.find("\"event\":\"explorer-restarted\"")==std::string::npos,"Replacement never enables attachment after startup or simulated restart");
        CloseHandle(process.hProcess);process={};
        std::cout<<"PASS "<<checks<<" native adapter integration checks; simulated commands, no Explorer injection\n"; return 0;
    } catch(const std::exception& error) {
        const DWORD windowsError=GetLastError();
        // Only the exact child created by this isolated test is cleaned up.
        if(process.hProcess) {if(panel)PostMessageW(panel,WM_CLOSE,0,0); if(WaitForSingleObject(process.hProcess,1000)==WAIT_TIMEOUT)TerminateProcess(process.hProcess,1); CloseHandle(process.hProcess);}
        std::cerr<<"FAIL "<<error.what()<<" (Windows error "<<windowsError<<")\n"; return 1;
    }
}
