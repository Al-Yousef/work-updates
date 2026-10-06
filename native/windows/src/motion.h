#pragma once
#include <algorithm>
#include <cmath>

struct Sample { double position, velocity; };
// A critically damped spring. Retargeting carries forward both position and velocity.
// Windows receives a short cubic approximation and runs it on the compositor.
struct Motion {
    static constexpr double duration = 0.32;
    static constexpr double omega = 28.0;
    double startTime = -1, startPosition = 0, startVelocity = 0, target = 0;
    Sample at(double now) const {
        const double t = std::max(0.0, now - startTime);
        if (startTime < 0 || t >= duration) return {target, 0};
        const double displacement = startPosition - target;
        const double coefficient = startVelocity + omega * displacement;
        const double decay = std::exp(-omega * t);
        return {target + (displacement + coefficient * t) * decay,
                (startVelocity - omega * coefficient * t) * decay};
    }
    void retarget(double next, double now) {
        const auto current = at(now);
        startPosition = current.position;
        startVelocity = current.velocity;
        target = next;
        startTime = now;
    }
};
