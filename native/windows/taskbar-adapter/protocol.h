#pragma once
#include <windows.h>
#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <cstdint>
#include <stdexcept>

namespace taskbar {
constexpr UINT message = WM_APP + 0x360;
enum class Command : LPARAM { Ready=1, Hover=2, Leave=3, Click=4, Stopped=5, Failed=6, Hello=7 };
constexpr std::uint64_t magic = 0x3152414254575557ULL;
struct Endpoint {
    std::uint64_t signature=magic, cookie=0, window=0;
    DWORD pid=0, version=1;
};
inline std::filesystem::path endpointPath(const std::filesystem::path& executable) {
    return executable.parent_path()/L"artifacts/taskbar-adapter.info";
}
inline Endpoint publish(HWND window, const std::filesystem::path& executable) {
    Endpoint endpoint;
    endpoint.window=reinterpret_cast<std::uintptr_t>(window); endpoint.pid=GetCurrentProcessId();
    if(BCryptGenRandom(nullptr,reinterpret_cast<PUCHAR>(&endpoint.cookie),sizeof(endpoint.cookie),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0 || !endpoint.cookie)
        throw std::runtime_error("Could not create the taskbar adapter session");
    const auto target=endpointPath(executable);
    const auto temporary=target.wstring()+L"."+std::to_wstring(endpoint.cookie)+L".tmp";
    const HANDLE file=CreateFileW(temporary.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(file==INVALID_HANDLE_VALUE)throw std::runtime_error("Could not create the taskbar adapter session");
    DWORD written=0;const bool saved=WriteFile(file,&endpoint,sizeof(endpoint),&written,nullptr)&&written==sizeof(endpoint)&&FlushFileBuffers(file);
    CloseHandle(file);
    if(!saved||!MoveFileExW(temporary.c_str(),target.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)){
        DeleteFileW(temporary.c_str());throw std::runtime_error("Could not publish the taskbar adapter session");
    }
    return endpoint;
}
inline bool readEndpoint(const std::filesystem::path& path, Endpoint& endpoint) {
    const HANDLE file=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
    if(file==INVALID_HANDLE_VALUE)return false;
    BY_HANDLE_FILE_INFORMATION information{};LARGE_INTEGER size{};Endpoint candidate{};DWORD read=0;
    const bool complete=GetFileInformationByHandle(file,&information)&&
        !(information.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&
        GetFileSizeEx(file,&size)&&size.QuadPart==sizeof(candidate)&&
        ReadFile(file,&candidate,sizeof(candidate),&read,nullptr)&&read==sizeof(candidate);
    CloseHandle(file);
    if(!complete||candidate.signature!=magic||candidate.version!=1||!candidate.cookie||!candidate.window||!candidate.pid)return false;
    endpoint=candidate;return true;
}
inline bool accepted(const Endpoint& endpoint, WPARAM cookie) { return endpoint.cookie && cookie==endpoint.cookie; }
}
