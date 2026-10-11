#pragma once
// iPhone Messages role hierarchy. Semantic task/transport data belongs to Hyphen.
// Segoe UI is a Windows adaptation; no Apple font assets or Liquid Glass claim.
namespace chatstyle {
constexpr const wchar_t* font=L"Segoe UI";
inline bool highContrast=false;
inline COLORREF foreground=RGB(242,242,247),background=RGB(28,28,30);
constexpr COLORREF fieldColor=RGB(44,44,46),linkColor=RGB(122,189,255),bubbleColor=RGB(0,110,238);
inline void refresh(bool synthetic=false) {
    HIGHCONTRASTW state{};state.cbSize=sizeof(state);
    highContrast=synthetic||(SystemParametersInfoW(SPI_GETHIGHCONTRAST,sizeof(state),&state,0)&&(state.dwFlags&HCF_HIGHCONTRASTON));
    // The synthetic palette belongs only to an isolated audit. Never change
    // Windows accessibility settings or its user-chosen system colors.
    foreground=highContrast?(synthetic?RGB(255,255,255):GetSysColor(COLOR_WINDOWTEXT)):RGB(242,242,247);
    background=highContrast?(synthetic?RGB(0,0,0):GetSysColor(COLOR_WINDOW)):RGB(28,28,30);
}
inline D2D1_COLOR_F color(COLORREF value){return D2D1::ColorF(GetRValue(value)/255.0f,GetGValue(value)/255.0f,GetBValue(value)/255.0f);}
inline D2D1_COLOR_F ink(){return color(foreground);}
inline D2D1_COLOR_F secondary(){return highContrast?ink():color(RGB(183,183,194));}
inline D2D1_COLOR_F surface(){return color(background);}
inline D2D1_COLOR_F inverse(){return highContrast?surface():D2D1::ColorF(1,1,1);}
inline D2D1_COLOR_F disabled(){return highContrast?ink():color(RGB(158,158,169));}
// Filled blue bubbles need white text; small actions need a brighter blue on
// dark surfaces. Keep those roles separate so both remain readable.
inline D2D1_COLOR_F blue(){return highContrast?ink():color(bubbleColor);}
inline D2D1_COLOR_F accent(){return highContrast?ink():color(linkColor);}
inline D2D1_COLOR_F separator(){return highContrast?ink():color(RGB(80,80,85));}
inline D2D1_COLOR_F incoming(){return highContrast?surface():color(RGB(56,56,59));}
inline D2D1_COLOR_F sidebar(){return highContrast?surface():color(RGB(36,36,38));}
inline D2D1_COLOR_F selected(){return highContrast?surface():color(RGB(52,59,72));}
inline D2D1_COLOR_F field(){return highContrast?surface():color(fieldColor);}
inline D2D1_COLOR_F hover(bool pressed){auto value=ink();value.a=pressed?.10f:.05f;return value;}
inline D2D1_COLOR_F amber(){return highContrast?ink():color(RGB(234,184,106));}
inline D2D1_COLOR_F red(){return highContrast?ink():color(RGB(255,140,140));}
inline D2D1_COLOR_F purple(){return highContrast?ink():color(RGB(200,169,255));}
inline D2D1_COLOR_F green(){return highContrast?ink():color(RGB(114,219,164));}
inline COLORREF editorBackground(){return highContrast?background:fieldColor;}
inline COLORREF editorText(){return foreground;}
inline COLORREF searchBackground(){return editorBackground();}
inline COLORREF placeholder(){return highContrast?foreground:RGB(183,183,194);}
}
