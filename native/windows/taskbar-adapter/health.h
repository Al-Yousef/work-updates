#pragma once
#include <atomic>
#include <cstdint>

namespace taskbar {
// Worker-owned acknowledgements. Explorer callbacks only read this lease;
// they never wait for panel IPC or read a descriptor from disk.
constexpr std::uint64_t healthIntervalMs=1000,healthTimeoutMs=200,healthLeaseMs=2000;
struct HealthLease {
    std::atomic<std::uint64_t> acknowledgedAt{0};
    void acknowledge(std::uint64_t tick) noexcept {acknowledgedAt.store(tick,std::memory_order_release);}
    void clear() noexcept {acknowledgedAt.store(0,std::memory_order_release);}
    bool fresh(std::uint64_t tick) const noexcept {
        const auto acknowledged=acknowledgedAt.load(std::memory_order_acquire);
        return acknowledged && tick>=acknowledged && tick-acknowledged<=healthLeaseMs;
    }
};
}
