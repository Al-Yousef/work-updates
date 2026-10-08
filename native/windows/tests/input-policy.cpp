#include "../src/input-policy.h"
#include "../src/chat-layout.h"
#include <limits>
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
    for(const auto scale:{1.0f,1.5f,2.25f})for(const auto width:{720.0f,880.0f,1280.0f})for(const auto height:{560.0f,660.0f,960.0f}){
        chatlayout::scaleText(scale);chatlayout::resize(width,height);
        assert(chatlayout::textScale==scale);assert(chatlayout::composerTextWidth>150);assert(chatlayout::composerTextRight<chatlayout::sendTargetLeft);
        assert(chatlayout::searchHeight>=22*scale);assert(chatlayout::searchTop+chatlayout::searchHeight<=height-22);
        // The final row's actual input rectangle ends three pixels before
        // its separator. Compare that rectangle with pagination's input edge.
        assert(chatlayout::listTop+chatlayout::visibleRows*chatlayout::rowHeight-3<height-90-(chatlayout::searchHeight-22)-22);
        assert(chatlayout::composerMinHeight>=15*scale*1.3f+2*chatlayout::composerPadding);
        assert(chatlayout::composerMaxHeight>=chatlayout::composerMinHeight);assert(chatlayout::transcriptTop<height-22-chatlayout::composerMaxHeight-24);
    }
    chatlayout::scaleText(std::numeric_limits<float>::quiet_NaN());assert(chatlayout::textScale==1);
    chatlayout::scaleText(100);assert(chatlayout::textScale==2.25f);chatlayout::scaleText(-1);assert(chatlayout::textScale==1);chatlayout::resize(880,660);
    assert(chatlayout::sidebarRight==296&&chatlayout::listTop==200&&chatlayout::rowHeight==70&&chatlayout::visibleRows==5);
    std::cout << "Text-scale layout keeps native fields, source rows and pagination in bounds across all supported sizes.\n";
    std::cout << "Weather-only button ownership, cancellation, and outside-input checks passed.\n";
}
