#pragma once
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <stdexcept>

// No heartbeat: the server releases its corner lease when this handle closes.
// A pending overlapped read also detects loss of the existing app without polling.
struct Bridge {
    HANDLE pipe = INVALID_HANDLE_VALUE;
    HANDLE event = nullptr;
    OVERLAPPED pending{};
    char input[2048]{};
    bool connected = false;
    ~Bridge() { close(); }
    void close() {
        connected = false;
        if (pipe != INVALID_HANDLE_VALUE) {CancelIoEx(pipe, nullptr); CloseHandle(pipe); pipe = INVALID_HANDLE_VALUE;}
        if (event) {CloseHandle(event); event = nullptr;}
    }
    DWORD complete(BOOL immediate, OVERLAPPED& operation, DWORD transferred) {
        if (!immediate && GetLastError() != ERROR_IO_PENDING)
            throw std::runtime_error("Native connection failed");
        if (!immediate) {
            if (WaitForSingleObject(operation.hEvent, 2500) != WAIT_OBJECT_0) {
                CancelIoEx(pipe, &operation);
                WaitForSingleObject(operation.hEvent, INFINITE);
                throw std::runtime_error("Work Updates did not acknowledge the native corner handoff");
            }
            if (!GetOverlappedResult(pipe, &operation, &transferred, FALSE))
                throw std::runtime_error("Native connection failed");
        }
        return transferred;
    }
    void claim(const std::filesystem::path& descriptor) {
        std::ifstream file(descriptor);
        std::string magic, name, token, pid;
        std::getline(file, magic); std::getline(file, name); std::getline(file, token); std::getline(file, pid);
        if (magic != "work-updates-native-v1" || name.rfind("\\\\.\\pipe\\work-updates-native-",0) != 0 ||
            token.size() != 64 || token.find_first_not_of("0123456789abcdef") != std::string::npos)
            throw std::runtime_error("Work Updates native control descriptor is invalid");
        pipe = CreateFileA(name.c_str(), GENERIC_READ|GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) throw std::runtime_error("Start Work Updates before its native preview");
        ULONG serverPid = 0;
        if (!GetNamedPipeServerProcessId(pipe, &serverPid) || serverPid != std::stoul(pid))
            throw std::runtime_error("The native connection belongs to a different app instance");
        event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!event) throw std::runtime_error("Could not create native connection event");
        OVERLAPPED operation{}; operation.hEvent = event;
        DWORD count = 0;
        const std::string request = "{\"method\":\"claimCorner\",\"token\":\"" + token + "\"}\n";
        const BOOL wrote = WriteFile(pipe, request.data(), static_cast<DWORD>(request.size()), &count, &operation);
        if (complete(wrote, operation, count) != request.size()) throw std::runtime_error("Native request was incomplete");
        std::string response;
        while (response.find('\n') == std::string::npos && response.size() < sizeof(input)) {
            ResetEvent(event); operation = {}; operation.hEvent = event; count = 0;
            const BOOL read = ReadFile(pipe, input, sizeof(input)-1, &count, &operation);
            count = complete(read, operation, count);
            if (!count) throw std::runtime_error("Work Updates closed the native connection");
            response.append(input, count);
        }
        if (response.find("\"ok\":true") == std::string::npos || response.find("\"cornerOwner\":\"native\"") == std::string::npos)
            throw std::runtime_error("Work Updates refused the native corner handoff");
        connected = true;
        ResetEvent(event); pending = {}; pending.hEvent = event; count = 0;
        const BOOL read = ReadFile(pipe, input, sizeof(input), &count, &pending);
        if (read || GetLastError() != ERROR_IO_PENDING) throw std::runtime_error("Work Updates closed the native connection");
    }
};
