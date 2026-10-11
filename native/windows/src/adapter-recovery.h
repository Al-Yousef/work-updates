#pragma once
#include <array>

namespace taskbar {
// A failed heartbeat restores Widgets immediately. Recovery runs later on the
// panel thread, with one controller at a time and a finite retry budget.
struct Recovery {
    static constexpr std::array<unsigned,6> delays{1000,2000,4000,8000,16000,30000};
    static constexpr unsigned stableMs=30000;
    unsigned attempts=0;
    bool pending=false;
    unsigned schedule(bool allowed,bool ready,bool controllerRunning) noexcept {
        if(!allowed||ready||controllerRunning||pending||attempts>=delays.size())return 0;
        pending=true;return delays[attempts++];
    }
    void started() noexcept {pending=false;}
    void ready() noexcept {pending=false;}
    // A Ready followed by another immediate failure must not reset the budget.
    void stable() noexcept {attempts=0;}
    void restarted() noexcept {attempts=0;pending=false;}
};
}
