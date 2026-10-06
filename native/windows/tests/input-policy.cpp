#include "../src/input-policy.h"
#include <cassert>
#include <iostream>
int main() {
    WeatherInputPolicy guard; bool activate=false;
    assert(!guard.down(false)); assert(!guard.up(true,activate)); assert(!activate);
    assert(guard.down(true)); assert(guard.up(true,activate)); assert(activate);
    assert(!guard.up(true,activate)); assert(!activate); // No duplicate command from an orphan release.
    assert(guard.down(true)); assert(guard.up(false,activate)); assert(!activate); // A cancelled click stays consumed.
    assert(guard.down(true,true)); assert(guard.up(true,activate,true)); assert(activate);
    assert(!guard.down(false,true)); assert(!guard.up(true,activate,true)); assert(!activate);
    for(int i=0;i<10000;++i){assert(!guard.down(false));assert(!guard.up(false,activate));assert(!activate);}
    std::cout << "Weather-only button ownership, cancellation, and outside-input checks passed.\n";
}
