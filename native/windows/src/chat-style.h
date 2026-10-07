#pragma once
// iPhone Messages role hierarchy. Semantic task/transport data belongs to Hyphen.
// Segoe UI is a Windows adaptation; no Apple font assets or Liquid Glass claim.
namespace chatstyle {
constexpr const wchar_t* font=L"Segoe UI";
inline bool highContrast=false;
inline COLORREF foreground=RGB(28,28,30),background=RGB(255,255,255);
inline void refresh(bool synthetic=false) {
    HIGHCONTRASTW state{};state.cbSize=sizeof(state);
    highContrast=synthetic||(SystemParametersInfoW(SPI_GETHIGHCONTRAST,sizeof(state),&state,0)&&(state.dwFlags&HCF_HIGHCONTRASTON));
    // The synthetic palette belongs only to an isolated audit. Never change
    // Windows accessibility settings or its user-chosen system colors.
    foreground=highContrast?(synthetic?RGB(255,255,255):GetSysColor(COLOR_WINDOWTEXT)):RGB(28,28,30);
    background=highContrast?(synthetic?RGB(0,0,0):GetSysColor(COLOR_WINDOW)):RGB(255,255,255);
}
inline D2D1_COLOR_F color(COLORREF value){return D2D1::ColorF(GetRValue(value)/255.0f,GetGValue(value)/255.0f,GetBValue(value)/255.0f);}
inline D2D1_COLOR_F ink(){return highContrast?color(foreground):D2D1::ColorF(.11f,.11f,.12f);}
inline D2D1_COLOR_F secondary(){return highContrast?ink():D2D1::ColorF(.40f,.40f,.43f);}
inline D2D1_COLOR_F surface(){return color(background);}
inline D2D1_COLOR_F inverse(){return highContrast?surface():D2D1::ColorF(1,1,1);}
inline D2D1_COLOR_F disabled(){return highContrast?ink():D2D1::ColorF(.62f,.62f,.65f);}
// Slightly deeper than default system blue: white 15-pixel message text and
// blue toolbar text both exceed 4.5:1 contrast on their opaque surfaces.
inline D2D1_COLOR_F blue(){return highContrast?ink():D2D1::ColorF(0,.43f,.93f);}
inline D2D1_COLOR_F separator(){return highContrast?ink():D2D1::ColorF(.84f,.84f,.86f);}
inline D2D1_COLOR_F incoming(){return highContrast?surface():D2D1::ColorF(.90f,.90f,.92f);}
inline D2D1_COLOR_F sidebar(){return highContrast?surface():D2D1::ColorF(.97f,.97f,.98f);}
inline D2D1_COLOR_F selected(){return highContrast?surface():D2D1::ColorF(.90f,.92f,.95f);}
inline COLORREF editorBackground(){return background;}
inline COLORREF editorText(){return foreground;}
inline COLORREF searchBackground(){return background;}
inline COLORREF placeholder(){return highContrast?foreground:RGB(102,102,110);}
}
