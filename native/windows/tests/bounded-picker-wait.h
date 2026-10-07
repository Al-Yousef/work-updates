#pragma once
#include <algorithm>
#include <cstdint>
namespace qa {
// Observation only. The action that opens the picker is never called here.
template<class Clock,class Poll,class Pause,class Cancel>
bool waitForPicker(std::uint64_t timeoutMs,Clock now,Poll poll,Pause pause,Cancel cancel) {
    const auto started=now();
    while(!cancel()) {
        const auto elapsed=now()-started;
        if(elapsed>=timeoutMs)return false;
        if(poll())return true;
        pause(std::min<std::uint64_t>(40,timeoutMs-elapsed));
    }
    return false;
}
}
