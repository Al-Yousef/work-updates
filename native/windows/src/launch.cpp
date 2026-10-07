#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shellapi.h>
#include <filesystem>
#include <string>
#include <fstream>
#include "deployment-paths.h"

// A user-facing launcher: open the existing preview, or start it visible.
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR argument,int) {
    wchar_t executable[32768]{};
    if(!GetModuleFileNameW(nullptr,executable,32768)) return 1;
    auto directory=std::filesystem::path(executable).parent_path();
    if(!std::filesystem::exists(directory/L"Native Hover.exe")) {
        wchar_t configured[32768]{};
        const DWORD count = GetEnvironmentVariableW(L"HYPHEN_NATIVE_ROOT", configured, 32768);
        directory = count && count < 32768 ? std::filesystem::path(configured)/L"build" : directory.parent_path()/L"native-hover"/L"build";
    }
    const auto target=(directory/L"Native Hover.exe").wstring();
    if(const HWND trigger=FindWindowW(L"NativeHoverTrigger",L"Native Hover Trigger")) {
        DWORD pid=0; GetWindowThreadProcessId(trigger,&pid);
        const HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
        if(!process) return 2;
        wchar_t actual[32768]{}; DWORD length=32768;
        const BOOL verified=QueryFullProcessImageNameW(process,0,actual,&length);
        CloseHandle(process);
        if(!verified || _wcsicmp(actual,target.c_str())!=0) return 3;
        // The same idempotent Open command used by this app's tray icon.
        if(wcscmp(argument,L"--exit")==0) return PostMessageW(trigger,WM_CLOSE,0,0)?0:4;
        return PostMessageW(trigger,WM_APP+1,0,NIN_SELECT)?0:4;
    }
    if(wcscmp(argument,L"--exit")==0)return 0;
    const auto backendRoot=deployment::installation(directory);
    const auto backend=backendRoot/L"desktop"/L"Work Updates.exe";
    const auto descriptor=backendRoot/L"data"/L"desktop"/L"native-control.info";
    auto ready=[&]() {
        std::ifstream file(descriptor);std::string magic,name,token,pid;
        std::getline(file,magic);std::getline(file,name);std::getline(file,token);std::getline(file,pid);
        if(magic!="work-updates-native-v1" || pid.empty())return false;
        DWORD id=0;try{id=static_cast<DWORD>(std::stoul(pid));}catch(...){return false;}
        HANDLE running=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,id);if(!running)return false;
        wchar_t image[32768]{};DWORD length=32768;
        bool valid=QueryFullProcessImageNameW(running,0,image,&length)&&!_wcsicmp(image,backend.c_str());
        CloseHandle(running);return valid;
    };
    if(!ready()) {
        std::wstring request=L"\""+backend.wstring()+L"\" --native-backend --hidden";
        STARTUPINFOW info{};info.cb=sizeof(info);info.dwFlags=STARTF_USESHOWWINDOW;info.wShowWindow=SW_HIDE;
        PROCESS_INFORMATION helper{};
        if(!CreateProcessW(backend.c_str(),request.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&info,&helper))return 6;
        CloseHandle(helper.hThread);CloseHandle(helper.hProcess);
        for(int i=0;i<100&&!ready();++i)Sleep(50);
        if(!ready())return 7;
    }
    std::wstring command=L"\""+target+L"\""+(wcscmp(argument,L"--hidden")==0?L"":L" --show");
    if(wcscmp(argument,L"--no-auto-attach")==0)command+=L" --no-auto-attach";
    STARTUPINFOW startup{}; startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
    PROCESS_INFORMATION process{};
    if(!CreateProcessW(target.c_str(),command.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&process)) return 5;
    CloseHandle(process.hThread); CloseHandle(process.hProcess); return 0;
}
