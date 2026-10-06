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
    std::ofstream file(endpointPath(executable),std::ios::binary|std::ios::trunc);
    file.write(reinterpret_cast<const char*>(&endpoint),sizeof(endpoint));
    if(!file)throw std::runtime_error("Could not publish the taskbar adapter session");
    return endpoint;
}
inline bool readEndpoint(const std::filesystem::path& path, Endpoint& endpoint) {
    std::ifstream file(path,std::ios::binary);
    file.read(reinterpret_cast<char*>(&endpoint),sizeof(endpoint));
    return file.gcount()==sizeof(endpoint) && file.peek()==EOF && endpoint.signature==magic &&
        endpoint.version==1 && endpoint.cookie && endpoint.window && endpoint.pid;
}
inline bool accepted(const Endpoint& endpoint, WPARAM cookie) { return endpoint.cookie && cookie==endpoint.cookie; }
}
