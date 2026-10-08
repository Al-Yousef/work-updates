#pragma once
#include <algorithm>
#include <cmath>
namespace chatlayout {
constexpr float minWidth=720,maxWidth=1280,minHeight=560,maxHeight=960;
inline float width=880,height=660;
inline float sidebarRight=296,chatLeft=318,chatRight=850;
inline float composerTop=598;
inline float textScale=1,listTop=200,rowHeight=70,pinY=130,transcriptTop=126;
constexpr float searchLeft=32;
inline float contactCenter=582,searchTop=606,searchWidth=232,pinX=148;
constexpr float messageSize=17,composerSize=15;
inline float searchHeight=22;
// The native editor, rendered bubble and click targets share these bounds.
inline float composerLeft=356,composerRight=852;
inline float composerTextLeft=368,sendCenter=834;
inline float sendTargetLeft=812;
inline float composerTextRight=802,composerTextWidth=434;
constexpr float composerPadding=10,composerMargin=2;
inline float composerMinHeight=40,composerMaxHeight=96;
inline int visibleRows=5;
inline void resize(float requestedWidth,float requestedHeight) {
    width=std::clamp(requestedWidth,minWidth,maxWidth);height=std::clamp(requestedHeight,minHeight,maxHeight);
    const auto extra=textScale-1;
    sidebarRight=std::min(width*.5f,std::min(296.0f,width*296/880)+100*extra);chatLeft=sidebarRight+22;chatRight=width-30;
    composerTop=height-62;contactCenter=(sidebarRight+width-12)/2;
    searchHeight=22*textScale;searchTop=height-32-searchHeight;searchWidth=sidebarRight-64;pinX=sidebarRight/2;
    pinY=130+39*extra;listTop=200+59*extra;rowHeight=70+55*extra;transcriptTop=126+55*extra;
    composerMinHeight=40+20*extra;composerMaxHeight=std::min(96+76*extra,height*.35f);
    composerLeft=chatLeft+38;composerRight=width-28;composerTextLeft=chatLeft+50;sendCenter=width-46;
    sendTargetLeft=sendCenter-22;composerTextRight=sendTargetLeft-10;composerTextWidth=composerTextRight-composerTextLeft;
    visibleRows=std::max(1,static_cast<int>((height-listTop-109-(searchHeight-22))/rowHeight));
}
inline void scaleText(float value){textScale=std::isfinite(value)?std::clamp(value,1.0f,2.25f):1.0f;resize(width,height);}
}
