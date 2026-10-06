#include "../src/motion.h"
#include <cassert>
#include <iostream>
int main() {
    Motion motion; motion.retarget(1,10);
    assert(motion.at(10).position==0);
    const auto before=motion.at(10.10);
    motion.retarget(0,10.10);
    const auto after=motion.at(10.10);
    assert(std::abs(before.position-after.position)<1e-9);
    assert(std::abs(before.velocity-after.velocity)<1e-9);
    for(int i=0;i<1000;++i) {
        const double now=10.10+i*0.001;
        const auto state=motion.at(now);
        assert(std::isfinite(state.position)&&std::isfinite(state.velocity));
        assert(state.position>-0.05&&state.position<1.05);
    }
    assert(motion.at(11).position==0 && motion.at(11).velocity==0);
    for(int i=0;i<100;++i) motion.retarget(i%2,20+i*0.017);
    assert(std::isfinite(motion.at(21.8).position));
    std::cout << "Motion continuity, rapid reversal, bounds and rest checks passed.\n";
}
