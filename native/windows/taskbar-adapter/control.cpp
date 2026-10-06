#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <stdexcept>
#include "profile.h"

namespace {
struct Handle {
    HANDLE value=nullptr;
    explicit Handle(HANDLE handle):value(handle){}
    ~Handle(){if(value && value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
};
struct Module {std::uintptr_t base=0; std::filesystem::path path;};
Module module(DWORD pid,const wchar_t* name) {
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid));
    if(snapshot.value==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot enumerate the shell modules");
    MODULEENTRY32W item{}; item.dwSize=sizeof(item);
    if(Module32FirstW(snapshot.value,&item))do {
        if(!_wcsicmp(item.szModule,name))return {reinterpret_cast<std::uintptr_t>(item.modBaseAddr),item.szExePath};
    } while(Module32NextW(snapshot.value,&item));
    return {};
}
DWORD call(HANDLE process,std::uintptr_t address,void* argument=nullptr) {
    Handle thread(CreateRemoteThread(process,nullptr,0,reinterpret_cast<LPTHREAD_START_ROUTINE>(address),argument,0,nullptr));
    if(!thread.value)throw std::runtime_error("Explorer refused the adapter control call");
    if(WaitForSingleObject(thread.value,5000)!=WAIT_OBJECT_0)throw std::runtime_error("Adapter control timed out");
    DWORD result=0;
    if(!GetExitCodeThread(thread.value,&result))throw std::runtime_error("Cannot read adapter control status");
    return result;
}
std::uintptr_t remoteSystemFunction(DWORD pid,const char* name) {
    const auto address=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),name);
    HMODULE owner=nullptr;
    if(!address || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(address),&owner))throw std::runtime_error("Cannot locate the Windows loader");
    wchar_t path[32768]{}; GetModuleFileNameW(owner,path,32768);
    const auto target=module(pid,std::filesystem::path(path).filename().c_str());
    if(!target.base)throw std::runtime_error("The shell loader module is missing");
    return target.base+reinterpret_cast<std::uintptr_t>(address)-reinterpret_cast<std::uintptr_t>(owner);
}
std::uintptr_t exportAddress(const Module& remote,const char* name) {
    const HMODULE local=LoadLibraryExW(remote.path.c_str(),nullptr,DONT_RESOLVE_DLL_REFERENCES);
    if(!local)throw std::runtime_error("Cannot read the local adapter exports");
    const auto address=GetProcAddress(local,name);
    const auto rva=reinterpret_cast<std::uintptr_t>(address)-reinterpret_cast<std::uintptr_t>(local);
    FreeLibrary(local);
    if(!address)throw std::runtime_error("The adapter control export is missing");
    return remote.base+rva;
}
DWORD status(HANDLE process,const Module& adapter) {return call(process,exportAddress(adapter,"AdapterStatus"));}
}
int wmain(int argc,wchar_t** argv) {
    try {
        const std::wstring action=argc==2?argv[1]:L"";
        if(action!=L"--attach" && action!=L"--detach" && action!=L"--status" && action!=L"--verify") {
            std::wcerr<<L"Usage: Taskbar Adapter Control.exe --verify|--attach|--detach|--status\n"; return 2;
        }
        DWORD pid=0; const HWND shell=GetShellWindow(); GetWindowThreadProcessId(shell,&pid);
        if(!pid)throw std::runtime_error("The desktop shell is not running");
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_VM_READ|PROCESS_CREATE_THREAD|
            PROCESS_VM_OPERATION|PROCESS_VM_WRITE|SYNCHRONIZE,FALSE,pid));
        if(!process.value)throw std::runtime_error("Cannot access the current desktop shell");
        wchar_t path[32768]{}, windows[32768]{}; DWORD size=32768;
        GetWindowsDirectoryW(windows,32768);
        const auto expected=(std::filesystem::path(windows)/L"explorer.exe").wstring();
        if(!QueryFullProcessImageNameW(process.value,0,path,&size) || _wcsicmp(expected.c_str(),path))
            throw std::runtime_error("The desktop owner is not Windows Explorer");
        const auto taskbarModule=module(pid,L"Taskbar.View.dll");
        if(!taskbarModule.base)throw std::runtime_error("Explorer has not loaded the Windows taskbar");
        const bool matches=taskbar::profileMatches(taskbarModule.path);
        if(action==L"--verify") {
            unsigned originalEntries=0;
            for(const auto& site:taskbar::sites) {
                std::array<unsigned char,16> bytes{}; SIZE_T read=0;
                if(ReadProcessMemory(process.value,reinterpret_cast<const void*>(taskbarModule.base+site.rva),bytes.data(),bytes.size(),&read) &&
                    read==bytes.size() && bytes==site.bytes)++originalEntries;
            }
            std::cout<<"{\"shellPid\":"<<pid<<",\"profileMatches\":"<<(matches?"true":"false")<<",\"originalEntries\":"<<originalEntries<<",\"checkedEntries\":"<<std::size(taskbar::sites)<<"}\n";
            return matches?0:3;
        }
        GetModuleFileNameW(nullptr,path,32768);
        const auto ownDll=std::filesystem::path(path).parent_path()/taskbar::adapterFilename;
        auto adapter=module(pid,ownDll.filename().c_str());
        if(adapter.base && _wcsicmp(adapter.path.c_str(),ownDll.c_str()))throw std::runtime_error("Another adapter path is already loaded");
        if(action==L"--status") {
            const DWORD counters=adapter.base?call(process.value,exportAddress(adapter,"AdapterStats")):0;
            std::cout<<"{\"shellPid\":"<<pid<<",\"state\":"<<(adapter.base?status(process.value,adapter):0)
                <<",\"hoverCalls\":"<<(counters>>24)<<",\"clickCalls\":"<<((counters>>16)&255)
                <<",\"redirectedClicks\":"<<((counters>>8)&255)<<",\"leaveCalls\":"<<(counters&255)<<"}\n"; return 0;
        }
        if(action==L"--detach") {
            if(adapter.base) {
                call(process.value,exportAddress(adapter,"AdapterStop"));
                for(int i=0;i<60 && status(process.value,adapter)!=0;++i)Sleep(50);
                if(status(process.value,adapter)!=0)throw std::runtime_error("Adapter did not finish restoring Widgets");
            }
            std::cout<<"{\"shellPid\":"<<pid<<",\"state\":0}\n"; return 0;
        }
        if(!matches)throw std::runtime_error("Unsupported taskbar build; no commands were changed");
        if(!std::filesystem::exists(ownDll))throw std::runtime_error("Build the taskbar adapter first");
        if(!adapter.base) {
            const auto text=ownDll.wstring(); const auto bytes=(text.size()+1)*sizeof(wchar_t);
            void* buffer=VirtualAllocEx(process.value,nullptr,bytes,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
            if(!buffer)throw std::runtime_error("Cannot allocate the adapter path in Explorer");
            SIZE_T written=0;
            if(!WriteProcessMemory(process.value,buffer,text.c_str(),bytes,&written) || written!=bytes) {
                VirtualFreeEx(process.value,buffer,0,MEM_RELEASE); throw std::runtime_error("Cannot provide the adapter path");
            }
            call(process.value,remoteSystemFunction(pid,"LoadLibraryW"),buffer);
            VirtualFreeEx(process.value,buffer,0,MEM_RELEASE);
            adapter=module(pid,ownDll.filename().c_str());
            if(!adapter.base)throw std::runtime_error("Explorer did not load the adapter");
        }
        call(process.value,exportAddress(adapter,"AdapterStart"));
        DWORD result=0;
        for(int i=0;i<60;++i) {result=status(process.value,adapter); if(result!=1)break; Sleep(50);}
        std::cout<<"{\"shellPid\":"<<pid<<",\"state\":"<<result<<"}\n";
        if(result!=2)throw std::runtime_error("The adapter declined to attach; check its diagnostic log");
        return 0;
    } catch(const std::exception& error) {std::cerr<<error.what()<<" (Windows error "<<GetLastError()<<")\n"; return 1;}
}
