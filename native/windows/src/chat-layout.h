#pragma once
namespace chatlayout {
constexpr float width=880,height=660;
constexpr float sidebarRight=296,chatLeft=318,chatRight=width-30;
constexpr float composerTop=height-62,listTop=200,rowHeight=70;
constexpr float contactCenter=(sidebarRight+width-12)/2;
constexpr float searchLeft=32,searchTop=606,searchWidth=232;
constexpr float pinX=148,pinY=130,transcriptTop=126;
constexpr float messageSize=17,composerSize=15;
// The native editor, rendered bubble and click targets share these bounds.
constexpr float composerLeft=chatLeft+38,composerRight=width-28;
constexpr float composerTextLeft=chatLeft+50,sendCenter=width-46;
constexpr float sendTargetLeft=sendCenter-22;
constexpr float composerTextRight=sendTargetLeft-10,composerTextWidth=composerTextRight-composerTextLeft;
constexpr float composerPadding=10,composerMargin=2,composerMinHeight=40,composerMaxHeight=96;
constexpr int visibleRows=5;
}
