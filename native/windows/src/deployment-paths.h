#pragma once
#include <windows.h>
#include <filesystem>
#include <string>

namespace deployment {
inline std::filesystem::path installation(const std::filesystem::path& executableDirectory) {
    wchar_t configured[32768]{};
    const DWORD count = GetEnvironmentVariableW(L"HYPHEN_INSTALL_ROOT", configured, 32768);
    if (count && count < 32768 && std::filesystem::path(configured).is_absolute())
        return std::filesystem::path(configured);
    // Compatibility with the existing portable layout. New development
    // checkouts use HYPHEN_INSTALL_ROOT or an explicit --bridge descriptor.
    return executableDirectory.parent_path().parent_path() / L"Work Updates";
}
}
