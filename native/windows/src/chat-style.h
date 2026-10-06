#pragma once
// iPhone Messages role hierarchy. Semantic task/transport data belongs to Hyphen.
// Segoe UI is a Windows adaptation; no Apple font assets or Liquid Glass claim.
namespace chatstyle {
constexpr const wchar_t* font=L"Segoe UI";
inline D2D1_COLOR_F ink(){return D2D1::ColorF(.11f,.11f,.12f);}
inline D2D1_COLOR_F secondary(){return D2D1::ColorF(.40f,.40f,.43f);}
// Slightly deeper than default system blue: white 15-pixel message text and
// blue toolbar text both exceed 4.5:1 contrast on their opaque surfaces.
inline D2D1_COLOR_F blue(){return D2D1::ColorF(0,.43f,.93f);}
inline D2D1_COLOR_F separator(){return D2D1::ColorF(.84f,.84f,.86f);}
inline D2D1_COLOR_F incoming(){return D2D1::ColorF(.90f,.90f,.92f);}
inline D2D1_COLOR_F sidebar(){return D2D1::ColorF(.97f,.97f,.98f);}
inline D2D1_COLOR_F selected(){return D2D1::ColorF(.90f,.92f,.95f);}
constexpr COLORREF editorBackground=RGB(255,255,255);
constexpr COLORREF editorText=RGB(28,28,30);
constexpr COLORREF searchBackground=RGB(255,255,255);
}
