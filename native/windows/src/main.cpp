#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <commdlg.h>
#include <commctrl.h>
#include <oleacc.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d2d1_1.h>
#include <dwrite.h>
#include <dcomp.h>
#include <wincodec.h>
#include <psapi.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <map>
#include <ctime>
#include <memory>
#include "motion.h"
#include "bridge.h"
#include "queue-client.h"
#include "queue-model.h"
#include "chat-layout.h"
#include "chat-style.h"
#include "ui-audit.h"
#include "status-presentation.h"
#include "input-guard.h"
#include "accessibility.h"
#include "../taskbar-adapter/protocol.h"
#include "deployment-paths.h"

template<class T> struct Com {
    T* value = nullptr;
    Com() = default;
    Com(const Com&) = delete;
    Com& operator=(const Com&) = delete;
    ~Com() { reset(); }
    void reset() { if (value) value->Release(); value = nullptr; }
    T** put() { reset(); return &value; }
    T* get() const { return value; }
    T* operator->() const { return value; }
};
void require(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        std::ostringstream out; out << operation << " failed (0x" << std::hex << result << ')';
        throw std::runtime_error(out.str());
    }
}
template<class T, class U> void query(U* from, Com<T>& to) {
    require(from->QueryInterface(__uuidof(T), reinterpret_cast<void**>(to.put())), "QueryInterface");
}
double clockSeconds() {
    LARGE_INTEGER ticks, frequency; QueryPerformanceCounter(&ticks); QueryPerformanceFrequency(&frequency);
    return static_cast<double>(ticks.QuadPart) / frequency.QuadPart;
}

constexpr UINT WM_TRAY = WM_APP + 1;
constexpr UINT TIMER_LEAVE = 1, TIMER_FINISH = 2, TIMER_AUDIT_EXIT = 3, TIMER_HOVER = 4, TIMER_CLOCK = 5, TIMER_DRAFT=6,TIMER_DETAILS=7;
constexpr UINT MENU_OPEN = 101, MENU_HIDE = 102, MENU_EXIT = 103, MENU_TARGET = 104, MENU_LOGS=105;
constexpr UINT REPLY_EDIT = 201;
constexpr UINT SEARCH_EDIT = 202;
constexpr float WIDTH=chatlayout::width,HEIGHT=chatlayout::height;
constexpr float CHAT_LEFT=chatlayout::chatLeft,SIDEBAR_RIGHT=chatlayout::sidebarRight;
constexpr float COMPOSER_TOP=chatlayout::composerTop;
enum class Mode { Hidden, Peek, Pinned };

std::wstring wide(const std::string& value) {
    if(value.empty())return {};
    int count=MultiByteToWideChar(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0);
    std::wstring result(count,0);
    MultiByteToWideChar(CP_UTF8,0,value.data(),static_cast<int>(value.size()),result.data(),count);return result;
}
#include "thumbnail-loader.h"
std::string utf8(const std::wstring& value) {
    if(value.empty())return {};
    int count=WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);
    std::string result(count,0);
    WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),result.data(),count,nullptr,nullptr);return result;
}
struct Hit {D2D1_RECT_F box;std::string action;Json card;bool enabled=true;};
struct Renderer {
    Com<ID3D11Device> gpu;
    Com<IDXGIDevice> dxgi;
    Com<IDXGISwapChain1> swap;
    Com<ID2D1Factory1> factory;
    Com<ID2D1Device> device;
    Com<ID2D1DeviceContext> canvas;
    Com<ID2D1Bitmap1> bitmap;
    Com<IDWriteFactory> text;
    Com<IDCompositionDevice> compositor;
    Com<IDCompositionTarget> target;
    Com<IDCompositionVisual> visual;
    Com<IDCompositionEffectGroup> opacity;
    float dpi = 96;
    unsigned draws = 0, commits = 0;
    double paintMs=0;
    QueueModel model;
    std::vector<Hit> hits;
    std::vector<Hit> messageTargets;
    int focused=-1;
    std::string popover;
    std::string pressedKey,copyText;
    float pointerX=-1,pointerY=-1,contextX=0,contextY=0;
    bool pointerInside=false;
    float composerHeight=40;
    HWND composerEditor=nullptr;
    bool exporting=false;
    float noticeHeight=0;
    std::string notice;
    std::map<std::wstring,std::unique_ptr<Com<IDWriteTextLayout>>> layouts;
    std::map<std::string,std::unique_ptr<Com<ID2D1Bitmap>>> images;
    std::map<std::string,bool> unavailableImages;
    std::set<std::string> loadingImages;
    std::map<std::wstring,std::unique_ptr<Com<IDWriteTextLayout>>> bubbleLayouts;
    ThumbnailLoader thumbnails;
    Com<IWICImagingFactory> imaging;

    void init(HWND window) {
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        HRESULT result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
            nullptr, 0, D3D11_SDK_VERSION, gpu.put(), nullptr, nullptr);
        if (FAILED(result)) result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
            nullptr, 0, D3D11_SDK_VERSION, gpu.put(), nullptr, nullptr);
        require(result, "D3D11CreateDevice");
        query(gpu.get(), dxgi);
        Com<IDXGIAdapter> adapter; require(dxgi->GetAdapter(adapter.put()), "GetAdapter");
        Com<IDXGIFactory2> dxFactory;
        require(adapter->GetParent(__uuidof(IDXGIFactory2), reinterpret_cast<void**>(dxFactory.put())), "GetParent");
        RECT bounds; GetClientRect(window, &bounds);
        dpi=static_cast<float>(bounds.right)*96/WIDTH;
        DXGI_SWAP_CHAIN_DESC1 description{};
        description.Width = bounds.right; description.Height = bounds.bottom;
        description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        description.SampleDesc.Count = 1; description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        description.BufferCount = 2; description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        description.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
        require(dxFactory->CreateSwapChainForComposition(gpu.get(), &description, nullptr, swap.put()), "CreateSwapChainForComposition");
        D2D1_FACTORY_OPTIONS options{};
        require(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory1), &options,
            reinterpret_cast<void**>(factory.put())), "D2D1CreateFactory");
        require(factory->CreateDevice(dxgi.get(), device.put()), "CreateDevice");
        require(device->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, canvas.put()), "CreateDeviceContext");
        Com<IDXGISurface> surface;
        require(swap->GetBuffer(0, __uuidof(IDXGISurface), reinterpret_cast<void**>(surface.put())), "GetBuffer");
        const auto properties = D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), dpi, dpi);
        require(canvas->CreateBitmapFromDxgiSurface(surface.get(), &properties, bitmap.put()), "CreateBitmapFromDxgiSurface");
        canvas->SetTarget(bitmap.get()); canvas->SetDpi(dpi, dpi);
        canvas->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        require(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
            reinterpret_cast<IUnknown**>(text.put())), "DWriteCreateFactory");
        require(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(imaging.put())),"Image decoder");
        require(DCompositionCreateDevice(dxgi.get(), __uuidof(IDCompositionDevice),
            reinterpret_cast<void**>(compositor.put())), "DCompositionCreateDevice");
        // Native edit controls belong above the DirectComposition surface.
        require(compositor->CreateTargetForHwnd(window, FALSE, target.put()), "CreateTargetForHwnd");
        require(compositor->CreateVisual(visual.put()), "CreateVisual");
        require(visual->SetContent(swap.get()), "SetContent");
        require(compositor->CreateEffectGroup(opacity.put()), "CreateEffectGroup");
        require(visual->SetEffect(opacity.get()), "SetEffect");
        require(target->SetRoot(visual.get()), "SetRoot");
        paint();
        settle(false);
        require(compositor->WaitForCommitCompletion(), "WaitForCommitCompletion");
    }
    void resize(HWND window) {
        if(!canvas.get())return;
        RECT bounds{};GetClientRect(window,&bounds);DXGI_SWAP_CHAIN_DESC1 size{};swap->GetDesc1(&size);
        if(size.Width!=static_cast<UINT>(bounds.right)||size.Height!=static_cast<UINT>(bounds.bottom)){
            canvas->SetTarget(nullptr);bitmap.reset();require(swap->ResizeBuffers(0,bounds.right,bounds.bottom,DXGI_FORMAT_UNKNOWN,0),"Resize panel");
            Com<IDXGISurface> surface;require(swap->GetBuffer(0,__uuidof(IDXGISurface),reinterpret_cast<void**>(surface.put())),"Resize surface");
            auto properties=D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET|D2D1_BITMAP_OPTIONS_CANNOT_DRAW,D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_PREMULTIPLIED),dpi,dpi);
            require(canvas->CreateBitmapFromDxgiSurface(surface.get(),&properties,bitmap.put()),"Resize target");canvas->SetTarget(bitmap.get());
        }
        canvas->SetDpi(dpi,dpi);
    }
    void write(const wchar_t* value, float size, D2D1_RECT_F box, D2D1_COLOR_F color,
               DWRITE_FONT_WEIGHT weight = DWRITE_FONT_WEIGHT_NORMAL,DWRITE_TEXT_ALIGNMENT align=DWRITE_TEXT_ALIGNMENT_LEADING) {
        const std::wstring key=std::wstring(value)+L"|"+std::to_wstring(size)+L"|"+
            std::to_wstring(weight)+L"|"+std::to_wstring(box.right-box.left)+L"|"+std::to_wstring(box.bottom-box.top)+L"|"+std::to_wstring(align);
        auto& cached=layouts[key];
        if(!cached) {
            cached=std::make_unique<Com<IDWriteTextLayout>>();
            Com<IDWriteTextFormat> format;
            require(text->CreateTextFormat(chatstyle::font,nullptr,weight,DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,size,L"en-US",format.put()),"CreateTextFormat");
            format->SetTextAlignment(align);
            require(text->CreateTextLayout(value,static_cast<UINT32>(wcslen(value)),format.get(),
                box.right-box.left,box.bottom-box.top,cached->put()),"CreateTextLayout");
            DWRITE_TRIMMING trim{DWRITE_TRIMMING_GRANULARITY_CHARACTER,0,0};
            Com<IDWriteInlineObject> ellipsis;require(text->CreateEllipsisTrimmingSign(format.get(),ellipsis.put()),"Text ellipsis");
            require((*cached)->SetTrimming(&trim,ellipsis.get()),"Text trimming");
        }
        Com<ID2D1SolidColorBrush> brush;require(canvas->CreateSolidColorBrush(color,brush.put()),"Text brush");
        canvas->DrawTextLayout(D2D1::Point2F(box.left,box.top),cached->get(),brush.get(),static_cast<D2D1_DRAW_TEXT_OPTIONS>(D2D1_DRAW_TEXT_OPTIONS_CLIP|D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT));
    }

    void paint(const std::filesystem::path& exportPath={}) {
        const auto started=clockSeconds();
        const auto focusKey=focused>=0&&focused<static_cast<int>(hits.size())?hitKey(hits[focused]):std::string();
        exporting=!exportPath.empty();measureNotice();
        if(layouts.size()>512)layouts.clear();
        canvas->BeginDraw(); canvas->Clear(D2D1::ColorF(0, 0));
        const auto panel = D2D1::RoundedRect(D2D1::RectF(12, 12, WIDTH-12, HEIGHT-12), 24, 24);
        Com<ID2D1SolidColorBrush> brush;
        require(canvas->CreateSolidColorBrush(D2D1::ColorF(0, 0.02f), brush.put()), "CreateSolidColorBrush");
        for(int padding = 10; padding >= 1; --padding) {
            brush->SetColor(D2D1::ColorF(0, 0.012f + (10-padding)*0.002f));
            canvas->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(12-padding, 14-padding,
                WIDTH-12+padding, HEIGHT-10+padding), 32+padding, 32+padding), brush.get());
        }
        brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillRoundedRectangle(panel,brush.get());
        Com<ID2D1RoundedRectangleGeometry> clip; require(factory->CreateRoundedRectangleGeometry(panel,clip.put()),"Panel clip");
        Com<ID2D1Layer> layer;require(canvas->CreateLayer(layer.put()),"Panel layer");
        canvas->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(),clip.get()),layer.get());
        brush->SetColor(chatstyle::sidebar());canvas->FillRectangle(D2D1::RectF(12,12,SIDEBAR_RIGHT,HEIGHT-12),brush.get());
        brush->SetColor(chatstyle::separator());canvas->DrawLine(D2D1::Point2F(SIDEBAR_RIGHT,12),D2D1::Point2F(SIDEBAR_RIGHT,HEIGHT-12),brush.get(),.5f);
        brush->SetColor(D2D1::ColorF(.76f,.76f,.78f));canvas->DrawRoundedRectangle(panel,brush.get(),.6f);
        write(L"Hyphen",26,D2D1::RectF(32,28,218,67),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
        brush->SetColor(D2D1::ColorF(.97f,.97f,.98f));canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(WIDTH-35,34),20,20),brush.get());
        brush->SetColor(chatstyle::separator());canvas->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(WIDTH-35,34),20,20),brush.get(),.6f);
        brush->SetColor(chatstyle::secondary());
        canvas->DrawLine(D2D1::Point2F(WIDTH-39,29),D2D1::Point2F(WIDTH-31,37),brush.get(),1.3f);
        canvas->DrawLine(D2D1::Point2F(WIDTH-31,29),D2D1::Point2F(WIDTH-39,37),brush.get(),1.3f);
        queuePaint(brush.get());
        if(!popover.empty())popoverPaint(brush.get());
        hits.push_back({D2D1::RectF(WIDTH-57,12,WIDTH-13,56),"close",Json::object()});
        focused=-1;
        if(!focusKey.empty())for(size_t i=0;i<hits.size();++i)if(hits[i].enabled&&hitKey(hits[i])==focusKey){focused=static_cast<int>(i);break;}
        const auto hovered=hitAt(pointerX,pointerY);
        if(pointerInside&&hovered&&hovered->enabled){
            brush->SetColor(D2D1::ColorF(0,0,0,pressedKey==hitKey(*hovered)?.085f:.035f));
            const auto& action=hovered->action;const auto& box=hovered->box;
            const bool circular=action=="send"||action=="addMenu"||action=="previous"||action=="next"||action=="chatLatest"||action=="sourceLatest"||action=="filterMenu"||action=="clearSearch"||action=="close";
            if(circular){const float radius=action=="clearSearch"?10:16;canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F((box.left+box.right)/2,(box.top+box.bottom)/2),radius,radius),brush.get());}
            else if(action=="assistant"){canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(chatlayout::pinX,chatlayout::pinY),32,32),brush.get());}
            else canvas->FillRoundedRectangle(D2D1::RoundedRect(box,10,10),brush.get());
        }
        if(focused>=0&&focused<static_cast<int>(hits.size())){brush->SetColor(chatstyle::blue());canvas->DrawRoundedRectangle(D2D1::RoundedRect(hits[focused].box,10,10),brush.get(),2);}
        canvas->PopLayer();
        require(canvas->EndDraw(), "EndDraw");
        if(!exportPath.empty())capture(exportPath);
        require(swap->Present(1,0), "Present"); ++draws;
        paintMs=(clockSeconds()-started)*1000;
    }
    static std::string hitKey(const Hit& hit) {return hit.action+"\n"+hit.card.value("id","")+"\n"+hit.card.value("taskKey","")+"\n"+hit.card.value("sourceId","")+"\n"+hit.card.value("messageId","")+"\n"+std::to_string(hit.card.value("index",-1));}
    const Hit* hitAt(float x,float y) const {for(auto it=hits.rbegin();it!=hits.rend();++it)if(x>=it->box.left&&x<=it->box.right&&y>=it->box.top&&y<=it->box.bottom)return &*it;return nullptr;}
    std::string pointerKey() const {const auto hit=pointerInside?hitAt(pointerX,pointerY):nullptr;return hit?hitKey(*hit):"";}
    void label(const std::string& value,float size,D2D1_RECT_F box,
               D2D1_COLOR_F color=chatstyle::ink(),DWRITE_FONT_WEIGHT weight=DWRITE_FONT_WEIGHT_NORMAL,DWRITE_TEXT_ALIGNMENT align=DWRITE_TEXT_ALIGNMENT_LEADING) {
        write(wide(value).c_str(),size,box,color,weight,align);
    }
    void centerLabel(const std::string& value,float size,D2D1_RECT_F box,D2D1_COLOR_F color=chatstyle::ink(),DWRITE_FONT_WEIGHT weight=DWRITE_FONT_WEIGHT_NORMAL) {
        label(value,size,box,color,weight,DWRITE_TEXT_ALIGNMENT_CENTER);
    }
    float composeY() const {return HEIGHT-22-composerHeight;}
    void contactHeader(ID2D1SolidColorBrush* brush,const Json& card,bool assistant) {
        const float center=chatlayout::contactCenter;
        const auto name=assistant?std::string("Hyphen"):card.value("chatName","");
        auto value=wide(name);Com<IDWriteTextFormat> format;require(text->CreateTextFormat(chatstyle::font,nullptr,DWRITE_FONT_WEIGHT_SEMI_BOLD,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,18,L"en-US",format.put()),"Contact format");
        Com<IDWriteTextLayout> layout;require(text->CreateTextLayout(value.c_str(),static_cast<UINT32>(value.size()),format.get(),280,28,layout.put()),"Contact name");
        DWRITE_TEXT_METRICS metrics{};layout->GetMetrics(&metrics);const float width=std::clamp(metrics.width+74,132.0f,354.0f);
        const auto box=D2D1::RectF(center-width/2,34,center+width/2,78);
        if(assistant){brush->SetColor(chatstyle::blue());canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(box.left+20,56),20,20),brush);
            brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(box.left+11,54,box.left+29,58),2,2),brush);
        }else deviceIcon(brush,card,box.left,36);
        label(name,18,D2D1::RectF(box.left+50,43,box.right-22,71),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
        brush->SetColor(chatstyle::secondary());canvas->DrawLine(D2D1::Point2F(box.right-13,51),D2D1::Point2F(box.right-8,56),brush,1.6f);canvas->DrawLine(D2D1::Point2F(box.right-8,56),D2D1::Point2F(box.right-13,61),brush,1.6f);
        hits.push_back({box,"detailsMenu",model.input()});
        if(!assistant)centerLabel(card.value("title",""),12,D2D1::RectF(CHAT_LEFT+14,92,WIDTH-42,115),chatstyle::secondary());
    }
    void button(ID2D1SolidColorBrush* brush, std::string title,D2D1_RECT_F box,std::string action,bool enabled=true) {
        (void)brush;
        // Text toolbar actions retain their full input target without heavy tiles.
        label(title,13,D2D1::RectF(box.left+10,box.top+(box.bottom-box.top-18)/2,box.right-6,box.bottom-4),
            enabled?chatstyle::blue():D2D1::ColorF(.62f,.62f,.65f));
        hits.push_back({box,action,Json::object(),enabled});
    }
    void circleButton(ID2D1SolidColorBrush* brush,D2D1_POINT_2F center,const std::string& action,bool enabled=true,bool blue=false) {
        const float radius=blue?14:20;
        brush->SetColor(blue&&enabled?chatstyle::blue():D2D1::ColorF(1,1,1));
        canvas->FillEllipse(D2D1::Ellipse(center,radius,radius),brush);
        if(!blue){brush->SetColor(chatstyle::separator());canvas->DrawEllipse(D2D1::Ellipse(center,radius,radius),brush,.6f);}
        brush->SetColor(blue&&enabled?D2D1::ColorF(1,1,1):enabled?chatstyle::ink():D2D1::ColorF(.64f,.64f,.67f));
        if(action=="attach"||action=="addMenu") {
            canvas->DrawLine(D2D1::Point2F(center.x-6,center.y),D2D1::Point2F(center.x+6,center.y),brush,1.6f);
            canvas->DrawLine(D2D1::Point2F(center.x,center.y-6),D2D1::Point2F(center.x,center.y+6),brush,1.6f);
        } else {
            const float direction=(action=="sourceLatest"||action=="chatLatest"||action=="next")?1:-1;
            canvas->DrawLine(D2D1::Point2F(center.x,center.y-direction*6),D2D1::Point2F(center.x,center.y+direction*6),brush,1.7f);
            canvas->DrawLine(D2D1::Point2F(center.x-5,center.y+direction),D2D1::Point2F(center.x,center.y+direction*6),brush,1.7f);
            canvas->DrawLine(D2D1::Point2F(center.x+5,center.y+direction),D2D1::Point2F(center.x,center.y+direction*6),brush,1.7f);
        }
        const bool contextual=action=="send"||action=="addMenu"||action=="sourceLatest"||action=="chatLatest";
        hits.push_back({D2D1::RectF(center.x-22,center.y-22,center.x+22,center.y+22),action,contextual?Json{{"id",model.composerKey()}}:Json::object(),enabled});
    }
    std::string statusText(const Json& card) {
        return statuspresentation::label(card);
    }
    D2D1_COLOR_F statusColor(const Json& card) {
        auto status=card.value("status","");
        if(status=="needs" || card.value("waitingOn",Json::object()).value("kind","")=="you")return D2D1::ColorF(.62f,.36f,0);
        if(status=="blocked")return D2D1::ColorF(.80f,.16f,.18f);
        if(status=="working" || status=="starting")return D2D1::ColorF(0,.37f,.82f);
        if(status=="waiting")return D2D1::ColorF(.46f,.29f,.69f);
        if(status=="ready"||card.value("readyForReview",false))return D2D1::ColorF(.12f,.48f,.30f);
        return chatstyle::secondary();
    }
    void deviceIcon(ID2D1SolidColorBrush* brush,const Json& card,float x,float y) {
        brush->SetColor(D2D1::ColorF(.82f,.85f,.90f));
        canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(x+20,y+20),20,20),brush);
        brush->SetColor(D2D1::ColorF(.36f,.42f,.51f));
        auto kind=card.value("device",Json::object()).value("kind","unknown");
        if(kind=="phone" || kind=="tablet") {
            canvas->DrawRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x+14,y+10,x+26,y+29),2,2),brush,1.5f);
            canvas->DrawLine(D2D1::Point2F(x+18,y+26),D2D1::Point2F(x+22,y+26),brush,1);
        } else if(kind=="pc" || kind=="mac" || kind=="linux") {
            canvas->DrawRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x+11,y+12,x+29,y+25),2,2),brush,1.5f);
            canvas->DrawLine(D2D1::Point2F(x+20,y+25),D2D1::Point2F(x+20,y+29),brush,1.5f);
            canvas->DrawLine(D2D1::Point2F(x+15,y+29),D2D1::Point2F(x+25,y+29),brush,1.5f);
        } else label("?",16,D2D1::RectF(x+15,y+9,x+30,y+30),chatstyle::secondary());
        brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(x+36,y+34),6,6),brush);
        brush->SetColor(statusColor(card));canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(x+36,y+34),4.3f,4.3f),brush);
    }
    std::string rendererChatTitle() const {return model.chatting()?"Updates":"Chat";}
    float chatBubble(ID2D1SolidColorBrush* brush,const std::string& content,float y,bool user,bool draw,bool terminal=true) {
        if(content.empty())return 0;
        const float left=CHAT_LEFT+8,right=WIDTH-36,maxWidth=(right-left)*.78f;
        auto value=wide(content);IDWriteTextLayout* layout=nullptr;
        if(auto found=bubbleLayouts.find(value);found!=bubbleLayouts.end())layout=found->second->get();
        else {Com<IDWriteTextFormat> format;require(text->CreateTextFormat(chatstyle::font,nullptr,DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,chatlayout::messageSize,L"en-US",format.put()),"Chat format");
        if(bubbleLayouts.size()>=512)bubbleLayouts.clear();auto cached=std::make_unique<Com<IDWriteTextLayout>>();
        require(text->CreateTextLayout(value.c_str(),static_cast<UINT32>(value.size()),format.get(),maxWidth-24,64000,cached->put()),"Chat layout");layout=cached->get();bubbleLayouts[value]=std::move(cached);}
        DWRITE_TEXT_METRICS metrics{};layout->GetMetrics(&metrics);const float height=std::max(34.0f,metrics.height+12);
        const float bubbleWidth=std::clamp(metrics.width+24,42.0f,maxWidth);
        const float bubbleLeft=user?right-bubbleWidth:left;
        if(draw) {
            brush->SetColor(user?chatstyle::blue():chatstyle::incoming());
            canvas->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(bubbleLeft,y,bubbleLeft+bubbleWidth,y+height),18,18),brush);
            if(terminal){Com<ID2D1PathGeometry> tail;require(factory->CreatePathGeometry(tail.put()),"Balloon tail");
            Com<ID2D1GeometrySink> sink;require(tail->Open(sink.put()),"Balloon path");
            const float edge=user?bubbleLeft+bubbleWidth:bubbleLeft,side=user?1:-1,base=y+height;
            sink->BeginFigure(D2D1::Point2F(edge-side*9,base-17),D2D1_FIGURE_BEGIN_FILLED);
            sink->AddBezier(D2D1::BezierSegment(D2D1::Point2F(edge-side*8,base-7),D2D1::Point2F(edge+side*1,base-2),D2D1::Point2F(edge+side*6,base-1)));
            sink->AddBezier(D2D1::BezierSegment(D2D1::Point2F(edge-side*2,base+1),D2D1::Point2F(edge-side*12,base-1),D2D1::Point2F(edge-side*16,base-7)));
            sink->EndFigure(D2D1_FIGURE_END_CLOSED);require(sink->Close(),"Close balloon path");canvas->FillGeometry(tail.get(),brush);}
            brush->SetColor(user?D2D1::ColorF(1,1,1):chatstyle::ink());canvas->DrawTextLayout(D2D1::Point2F(bubbleLeft+12,y+6),layout,brush,D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
            const auto target=D2D1::RectF(bubbleLeft,std::max(chatlayout::transcriptTop,y),bubbleLeft+bubbleWidth,std::min(transcriptBottom(),y+height));
            if(target.bottom>target.top)messageTargets.push_back({target,"message",{{"text",content},{"tail",terminal}}});
        }
        return height+(terminal?10:3);
    }
    ID2D1Bitmap* imageBitmap(const Json& image) {
        const auto file=image.value("path","");if(file.empty()||unavailableImages.contains(file))return nullptr;
        if(images.contains(file))return images[file]->get();
        if(!loadingImages.contains(file)&&thumbnails.request(file))loadingImages.insert(file);
        return nullptr;
    }
    void thumbnailEvents() {
        for(auto& preview:thumbnails.take()) {
            loadingImages.erase(preview.file);
            if(preview.pixels.empty()){if(unavailableImages.size()>=64)unavailableImages.clear();unavailableImages[preview.file]=true;continue;}
            if(images.size()>=32)images.erase(images.begin());
            auto bitmap=std::make_unique<Com<ID2D1Bitmap>>();const auto properties=D2D1::BitmapProperties(D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_PREMULTIPLIED));
            if(SUCCEEDED(canvas->CreateBitmap(D2D1::SizeU(preview.width,preview.height),preview.pixels.data(),preview.width*4,&properties,bitmap->put())))images[preview.file]=std::move(bitmap);
            else unavailableImages[preview.file]=true;
        }
    }
    void thumbnail(ID2D1SolidColorBrush* brush,const Json& image,D2D1_RECT_F box) {
        brush->SetColor(chatstyle::incoming());canvas->FillRoundedRectangle(D2D1::RoundedRect(box,18,18),brush);
        if(auto bitmap=imageBitmap(image)) {
            auto size=bitmap->GetSize();auto scale=std::min((box.right-box.left)/size.width,(box.bottom-box.top)/size.height);
            const float w=size.width*scale,h=size.height*scale,cx=(box.left+box.right)/2,cy=(box.top+box.bottom)/2;
            const auto imageBox=D2D1::RectF(cx-w/2,cy-h/2,cx+w/2,cy+h/2);
            Com<ID2D1RoundedRectangleGeometry> mask;
            require(factory->CreateRoundedRectangleGeometry(D2D1::RoundedRect(imageBox,18,18),mask.put()),"Image corner mask");
            canvas->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(),mask.get()),nullptr);
            canvas->DrawBitmap(bitmap,imageBox,1,D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC);
            canvas->PopLayer();
        }else label(unavailableImages.contains(image.value("path",""))?"Image unavailable":"Loading image…",11,D2D1::RectF(box.left+8,box.top+12,box.right-4,box.bottom-4));
    }
    float messageImages(ID2D1SolidColorBrush* brush,const Json& value,float y,bool user,bool draw,float top,float bottom) {
        float height=0;for(const auto& image:value) {
            float width=280;
            if(draw&&y+height+178>=top&&y+height<=bottom){if(auto bitmap=imageBitmap(image)){auto size=bitmap->GetSize();width=std::clamp(178*size.width/std::max(1.0f,size.height),84.0f,400.0f);}}
            const float left=user?WIDTH-28-width:CHAT_LEFT;const auto box=D2D1::RectF(left,y+height,left+width,y+height+178);
            if(draw&&box.bottom>=top&&box.top<=bottom){thumbnail(brush,image,box);auto clipped=box;clipped.top=std::max(top,box.top);clipped.bottom=std::min(bottom,box.bottom);hits.push_back({clipped,"openImage",image});}
            height+=190;
        }return height;
    }
    std::string statusNotice() const {
        if(!model.connected)return "Reconnecting… Your draft is saved. Send will be available when connected.";
        if(!model.chatting()&&!model.selectedId.empty()&&model.sourceId.empty()&&model.selected().value("status","")=="queued")return "Locally queued · This task has not started.";
        if(!model.message.empty())return model.message;
        if(model.pending&&model.pendingOwner==model.composerKey())return model.pendingCommand=="queueMessage"?"Queueing…":model.pendingCommand=="assistantAsk"?"Sending to Hyphen…":model.pendingCommand=="send"?"Sending…":model.pendingCommand=="attachImages"?"Adding images…":"Updating…";
        if(!model.detailError.empty())return model.detailError;
        if(model.detailPending&&GetTickCount64()-model.detailStarted>=150)return model.detail.empty()?"Loading messages… You can write your reply.":"Updating messages…";
        if(model.pending)return "Finishing an action in "+model.pendingDestination()+". You can keep writing.";
        if(!model.selectedId.empty()&&!model.detail.empty()&&!model.currentSource().value("contextLoaded",false))return "Loading chat history… You can write your reply.";
        if(model.chatting()){const auto ai=model.state.value("assistant",Json::object());if(!ai.value("error","").empty())return ai.value("error","");return ai.value("responding",false)?"Hyphen is thinking…":"";}
        if(!model.sourceAvailable())return "This chat's status is unavailable. Your draft is saved. Check the source before sending.";
        const auto source=model.currentSource();if(!source.value("deliveryIssue","").empty())return source.value("deliveryIssue","");
        const int count=source.value("queuedMessages",0);if(count)return std::to_string(count)+" queued in Hyphen";
        if(model.defaultQueue())return "Chat is working · Your reply will queue";
        return "";
    }
    float noticeBottom() const {return composeY()-(model.images().empty()?8:108);}
    void measureNotice() {
        notice=statusNotice();noticeHeight=0;if(notice.empty())return;
        const auto value=wide(notice);Com<IDWriteTextFormat> format;require(text->CreateTextFormat(chatstyle::font,nullptr,DWRITE_FONT_WEIGHT_NORMAL,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,12,L"en-US",format.put()),"Status format");
        Com<IDWriteTextLayout> layout;require(text->CreateTextLayout(value.c_str(),static_cast<UINT32>(value.size()),format.get(),WIDTH-CHAT_LEFT-132,64000,layout.put()),"Status measure");
        DWRITE_TEXT_METRICS metrics{};layout->GetMetrics(&metrics);noticeHeight=std::clamp(metrics.height+20,36.0f,144.0f);
    }
    void noticePaint(ID2D1SolidColorBrush* brush) {
        if(notice.empty())return;const float bottom=noticeBottom();const auto box=D2D1::RectF(CHAT_LEFT+38,bottom-noticeHeight,WIDTH-80,bottom);
        brush->SetColor(D2D1::ColorF(.96f,.96f,.97f));canvas->FillRoundedRectangle(D2D1::RoundedRect(box,12,12),brush);
        label(notice,12,D2D1::RectF(box.left+10,box.top+9,box.right-10,box.bottom-8),chatstyle::secondary());
        if(!model.detailError.empty()){const auto retry=D2D1::RectF(WIDTH-76,bottom-44,WIDTH-28,bottom);centerLabel("Retry",12,retry,chatstyle::blue());hits.push_back({retry,"retryDetails",model.input(),model.connected});}
    }
    float transcriptBottom() const {return notice.empty()?(model.images().empty()?composeY()-44:composeY()-110):noticeBottom()-noticeHeight-10;}
    void composerPaint(ID2D1SolidColorBrush* brush) {
        const float top=composeY();const auto attached=model.images();
        float x=CHAT_LEFT+38;for(const auto& image:attached) {
            const auto box=D2D1::RectF(x,top-92,x+70,top-22);thumbnail(brush,image,box);
            hits.push_back({box,"openImage",image});
            const auto remove=D2D1::RectF(x+42,top-108,x+86,top-64);
            brush->SetColor(D2D1::ColorF(.25f,.25f,.28f,.9f));canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(x+64,top-86),10,10),brush);
            centerLabel("×",14,D2D1::RectF(x+52,top-98,x+76,top-74),D2D1::ColorF(1,1,1));
            hits.push_back({remove,"removeImage",image,model.canDraft()});x+=90;
        }
        const auto box=D2D1::RoundedRect(D2D1::RectF(chatlayout::composerLeft,top,chatlayout::composerRight,HEIGHT-22),20,20);
        brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillRoundedRectangle(box,brush);
        brush->SetColor(D2D1::ColorF(.90f,.90f,.92f));canvas->DrawRoundedRectangle(box,brush,.65f);
        // The EDIT draws live text and its caret. Do not draw a second, differently
        // wrapped copy underneath it; the fallback is only for exported scenes.
        if(exporting||!IsWindowVisible(composerEditor))label(model.draft().empty()?"Message…":model.draft(),chatlayout::composerSize,D2D1::RectF(chatlayout::composerTextLeft+chatlayout::composerMargin,top+chatlayout::composerPadding,chatlayout::composerTextRight-chatlayout::composerMargin,HEIGHT-22-chatlayout::composerPadding),model.draft().empty()?chatstyle::secondary():chatstyle::ink());
        circleButton(brush,D2D1::Point2F(CHAT_LEFT+12,top+composerHeight/2),"addMenu",model.canDraft()&&model.connected&&!model.pending);
        circleButton(brush,D2D1::Point2F(chatlayout::sendCenter,top+composerHeight/2),"send",model.canReply()&&model.hasDraft(),true);
    }
    void assistantPaint(ID2D1SolidColorBrush* brush) {
        const auto muted=chatstyle::secondary();const auto ai=model.state.value("assistant",Json::object());
        contactHeader(brush,Json::object(),true);
        auto messages=ai.value("messages",Json::array());const float top=chatlayout::transcriptTop,bottom=transcriptBottom();float total=0;
        for(const auto& m:messages) {
            total+=chatBubble(brush,m.value("text",""),0,true,false,m.value("images",Json::array()).empty());
            total+=messageImages(brush,m.value("images",Json::array()),0,true,false,top,bottom);
            auto answer=m.value("status","")=="thinking"?"Thinking…":m.value("status","")=="failed"?m.value("error","Could not answer."):m.value("answer","");
            total+=chatBubble(brush,answer,0,false,false)+m.value("links",Json::array()).size()*48;
        }
        model.assistantOffset=std::clamp(model.assistantOffset,0,std::max(0,static_cast<int>(total-bottom+top)));
        canvas->PushAxisAlignedClip(D2D1::RectF(CHAT_LEFT,top,WIDTH-28,bottom),D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        float y=top-model.assistantOffset;
        if(messages.empty()) {
            label("Talk to Hyphen",24,D2D1::RectF(CHAT_LEFT+8,185,WIDTH-36,230),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            label("Ask about your work, think through an idea, or share an image.",16,D2D1::RectF(CHAT_LEFT+8,244,WIDTH-36,310),muted);
            button(brush,"What needs me?",D2D1::RectF(CHAT_LEFT+8,334,CHAT_LEFT+196,378),"askNeeds",model.canReply());
            button(brush,"What changed?",D2D1::RectF(CHAT_LEFT+208,334,CHAT_LEFT+396,378),"askChanges",model.canReply());
        }
        for(const auto& m:messages) {
            y+=chatBubble(brush,m.value("text",""),y,true,true,m.value("images",Json::array()).empty());
            y+=messageImages(brush,m.value("images",Json::array()),y,true,true,top,bottom);
            auto answer=m.value("status","")=="thinking"?"Thinking…":m.value("status","")=="failed"?m.value("error","Could not answer."):m.value("answer","");
            y+=chatBubble(brush,answer,y,false,true);
            for(const auto& link:m.value("links",Json::array())) {
                auto box=D2D1::RectF(CHAT_LEFT,y,WIDTH-28,y+40);
                if(y>=top&&y+40<=bottom){button(brush,std::string(link.value("hasDraft",false)?"Use draft · ":"Open update · ")+link.value("chatName",""),box,"assistantUse",!model.pending);
                    if(!model.pending)hits.back().card={{"messageId",m.value("id","")},{"index",link.value("index",0)}};}
                else label(link.value("chatName",""),12,box,muted);
                y+=48;
            }
        }
        canvas->PopAxisAlignedClip();

        if(model.assistantOffset<std::max(0,static_cast<int>(total-bottom+top)))circleButton(brush,D2D1::Point2F(WIDTH-46,composeY()-25),"chatLatest");
        composerPaint(brush);
    }
    void sidebarPaint(ID2D1SolidColorBrush* brush) {
        const auto muted=chatstyle::secondary();
        const bool assistant=model.chatting();
        const int view=model.view==4?0:model.view;
        const bool filtered=view!=0;
        const float filterX=SIDEBAR_RIGHT-38;
        brush->SetColor(filtered?chatstyle::blue():D2D1::ColorF(1,1,1));canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(filterX,46),20,20),brush);
        brush->SetColor(chatstyle::separator());canvas->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(filterX,46),20,20),brush,.6f);
        brush->SetColor(filtered?D2D1::ColorF(1,1,1):chatstyle::ink());
        for(int i=0;i<3;++i)canvas->DrawLine(D2D1::Point2F(filterX-7+i*2,41+i*5),D2D1::Point2F(filterX+7-i*2,41+i*5),brush,1.5f);
        hits.push_back({D2D1::RectF(filterX-22,24,filterX+22,68),"filterMenu",Json::object()});
        const float searchY=chatlayout::searchTop+12;
        const auto searchBox=D2D1::RoundedRect(D2D1::RectF(28,searchY-22,280,searchY+22),22,22);
        brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillRoundedRectangle(searchBox,brush);
        brush->SetColor(chatstyle::separator());canvas->DrawRoundedRectangle(searchBox,brush,.6f);
        brush->SetColor(muted);canvas->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(42,searchY-2),5,5),brush,1.5f);canvas->DrawLine(D2D1::Point2F(46,searchY+2),D2D1::Point2F(51,searchY+7),brush,1.5f);
        label(model.search.empty()?"Search chats and tasks":model.search,13,D2D1::RectF(52,chatlayout::searchTop,model.search.empty()?264:240,chatlayout::searchTop+24),muted);
        if(!model.search.empty()){
            brush->SetColor(muted);canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(262,searchY),7,7),brush);
            brush->SetColor(D2D1::ColorF(1,1,1));canvas->DrawLine(D2D1::Point2F(259,searchY-3),D2D1::Point2F(265,searchY+3),brush,1.2f);canvas->DrawLine(D2D1::Point2F(265,searchY-3),D2D1::Point2F(259,searchY+3),brush,1.2f);
            hits.push_back({D2D1::RectF(240,searchY-22,284,searchY+22),"clearSearch",Json::object()});
        }
        const auto assistantBox=D2D1::RectF(106,94,190,190);
        if(assistant){brush->SetColor(chatstyle::blue());canvas->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(chatlayout::pinX,chatlayout::pinY),33,33),brush,2);}
        brush->SetColor(chatstyle::blue());canvas->FillEllipse(D2D1::Ellipse(D2D1::Point2F(chatlayout::pinX,chatlayout::pinY),28,28),brush);
        brush->SetColor(D2D1::ColorF(1,1,1));canvas->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(137,127,159,132),2.5f,2.5f),brush);
        centerLabel("Hyphen",12,D2D1::RectF(106,170,190,190),assistant?chatstyle::ink():muted);
        hits.push_back({assistantBox,"assistant",Json::object()});
        auto cards=model.cards();
        for(size_t index=model.offset;index<cards.size()&&index<size_t(model.offset+chatlayout::visibleRows);++index) {
            const auto& card=cards[index];float top=chatlayout::listTop+(index-model.offset)*chatlayout::rowHeight;
            const auto box=D2D1::RectF(20,top,SIDEBAR_RIGHT-8,top+chatlayout::rowHeight-3);
            bool selected=card.value("id","")==model.selectedId&&card.value("taskKey","")==model.selectedKey;
            if(selected){brush->SetColor(chatstyle::selected());canvas->FillRoundedRectangle(D2D1::RoundedRect(box,10,10),brush);}
            deviceIcon(brush,card,36,top+11);
            const auto age=std::max(0LL,static_cast<long long>(std::time(nullptr))-card.value("at",0LL));
            const std::string time=card.value("at",0LL)<=0?"":age<60?"Now":age<3600?std::to_string(age/60)+"m":age<86400?std::to_string(age/3600)+"h":std::to_string(age/86400)+"d";
            label(card.value("chatName",""),15,D2D1::RectF(90,top+4,230,top+27),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            label(time,11,D2D1::RectF(238,top+7,268,top+26),muted,DWRITE_FONT_WEIGHT_NORMAL,DWRITE_TEXT_ALIGNMENT_TRAILING);
            brush->SetColor(muted);canvas->DrawLine(D2D1::Point2F(278,top+12),D2D1::Point2F(282,top+16),brush,1.1f);canvas->DrawLine(D2D1::Point2F(282,top+16),D2D1::Point2F(278,top+20),brush,1.1f);
            label(card.value("title",""),13,D2D1::RectF(90,top+28,274,top+48),muted);
            label(statusText(card),11,D2D1::RectF(90,top+49,274,top+66),statusColor(card));
            brush->SetColor(chatstyle::separator());canvas->DrawLine(D2D1::Point2F(90,top+chatlayout::rowHeight-1),D2D1::Point2F(280,top+chatlayout::rowHeight-1),brush,.5f);
            hits.push_back({box,"card",card});
        }
        if(cards.empty()) {
            centerLabel(model.search.empty()?"You're caught up":"No results",15,D2D1::RectF(30,242,276,268),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            centerLabel(model.search.empty()?(view==0?"New updates appear here.":"No chats in this view."):"Try another chat name or task.",12,D2D1::RectF(30,279,276,320),muted);
        }
        const auto health=model.state.value("health",Json::object());
        const char* views[]{"Updates","Queued","History","Done"};
        label(model.connected?(health.value("ok",false)?std::to_string(cards.size())+(cards.size()==1?" chat · ":" chats · ")+views[view]:"Codex reconnecting"):"Reconnecting",11,D2D1::RectF(32,562,200,585),muted);
        if(cards.size()>chatlayout::visibleRows) {
            circleButton(brush,D2D1::Point2F(222,570),"previous",model.offset>0);
            circleButton(brush,D2D1::Point2F(266,570),"next",model.offset+chatlayout::visibleRows<static_cast<int>(cards.size()));
        }
    }
    void popoverPaint(ID2D1SolidColorBrush* brush) {
        hits.clear();const bool assistant=model.chatting();const auto card=model.selected();
        float left=popover=="copy"?contextX:popover=="filters"?SIDEBAR_RIGHT-240:popover=="add"?CHAT_LEFT-8:chatlayout::contactCenter-160;
        float top=popover=="copy"?contextY:popover=="filters"?72:popover=="add"?composeY()-182:86;
        const float width=popover=="copy"?180:popover=="details"?320:224;
        const auto source=model.currentSource();const bool recovery=!source.value("deliveryIssue","").empty()||source.value("queuedMessages",0)>0;
        const float height=popover=="copy"?60:popover=="filters"?296:popover=="add"?164:assistant?164:recovery?426:382;
        const auto box=D2D1::RectF(left,top,left+width,top+height);
        for(int i=6;i>=1;--i){brush->SetColor(D2D1::ColorF(0,0,0,.013f));canvas->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(left-i,top+2-i,box.right+i,box.bottom+4+i),16+i,16+i),brush);}
        brush->SetColor(D2D1::ColorF(1,1,1,.995f));canvas->FillRoundedRectangle(D2D1::RoundedRect(box,16,16),brush);
        brush->SetColor(chatstyle::separator());canvas->DrawRoundedRectangle(D2D1::RoundedRect(box,16,16),brush,.5f);
        auto item=[&](const std::string& title,const std::string& action,float y,bool enabled=true){
            label(title,15,D2D1::RectF(left+(popover=="filters"?46:16),y+10,box.right-12,y+36),enabled?chatstyle::ink():D2D1::ColorF(.6f,.6f,.63f));
            hits.push_back({D2D1::RectF(left+6,y,box.right-6,y+44),action,model.input(),enabled});};
        if(popover=="copy") {item("Copy","copyMessage",top+8);}
        else if(popover=="filters") {
            const char* names[]{"Updates","Queued","History","Done"};const int view=model.view==4?0:model.view;
            for(int i=0;i<4;++i){item(names[i],"tab"+std::to_string(i),top+8+i*44);if(view==i){brush->SetColor(chatstyle::ink());canvas->DrawLine(D2D1::Point2F(left+19,top+26+i*44),D2D1::Point2F(left+23,top+30+i*44),brush,1.6f);canvas->DrawLine(D2D1::Point2F(left+23,top+30+i*44),D2D1::Point2F(left+30,top+22+i*44),brush,1.6f);}}
            brush->SetColor(chatstyle::separator());canvas->DrawLine(D2D1::Point2F(left+12,top+191),D2D1::Point2F(box.right-12,top+191),brush,.6f);
            item(model.browseAll?"Recent chats":"Include older chats","browse",top+199);
            item("Undo last action","undo",top+243,model.state.value("undo",false)&&!model.pending);
        } else if(popover=="add") {
            item("Add image…","attach",top+8,model.canDraft()&&model.connected&&model.images().size()<4);
            if(!assistant)item(model.defaultQueue()?"Send now":"Queue next reply",model.defaultQueue()?"sendNow":"queue",top+52,model.canReply()&&model.hasDraft());
            label("Enter "+std::string(model.defaultQueue()?"queues":"sends")+" · Shift+Enter for a new line",10,D2D1::RectF(left+16,top+120,box.right-14,top+151),chatstyle::secondary());
        } else if(assistant) {
            item("Memory","memory",top+8,model.canReply());item("What needs me?","askNeeds",top+52,model.canReply());item("What changed?","askChanges",top+96,model.canReply());
        } else {
            label("CURRENT TASK",10,D2D1::RectF(left+16,top+12,box.right-16,top+30),chatstyle::secondary());
            label(card.value("title",""),14,D2D1::RectF(left+16,top+34,box.right-16,top+75),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            label(statusText(card),12,D2D1::RectF(left+16,top+78,box.right-16,top+98),statusColor(card));
            label(card.value("summaryNotice","Recorded update"),11,D2D1::RectF(left+16,top+106,box.right-16,top+128),chatstyle::secondary());
            item("Open chat","open",top+142,!model.pending&&!model.sourceId.empty());
            const bool issue=!source.value("deliveryIssue","").empty(),enabled=!model.pending&&!card.value("done",false);
            item("Reviewed","reviewed",top+186,enabled&&card.value("status","")!="queued");
            item("Snooze 1h","snooze",top+230,enabled);
            item(card.value("done",false)?"Reopen task":"Mark task done",card.value("done",false)?"reopen":"done",top+274,!model.pending);
            if(recovery)item(issue?"Checked reply":"Clear queue",issue?"checked":"clearQueue",top+318,enabled);
            if(card.value("sources",Json::array()).size()>1)item("Switch source","source",top+(recovery?362:318));
        }
    }
    void queuePaint(ID2D1SolidColorBrush* brush) {
        hits.clear();messageTargets.clear();sidebarPaint(brush);
        const auto muted=chatstyle::secondary();
        if(!model.connected&&model.state.empty()) {
            label("Connecting to your chats",24,D2D1::RectF(CHAT_LEFT,185,WIDTH-36,245),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            label(model.message.empty()?"Your saved conversations will appear here.":model.message,15,D2D1::RectF(CHAT_LEFT,262,WIDTH-36,340),muted);
            return;
        }
        if(model.chatting())assistantPaint(brush);
        else if(!model.selectedId.empty()) {
            auto card=model.selected();
            contactHeader(brush,card,false);const auto source=model.currentSource();
            auto messages=model.conversation();
            const float top=chatlayout::transcriptTop,bottom=transcriptBottom();
            if(messages.empty()) {label("Latest update",12,D2D1::RectF(CHAT_LEFT+8,top+12,WIDTH-40,top+36),muted);label(card.value("summary","Messages will appear here."),15,D2D1::RectF(CHAT_LEFT+8,top+44,WIDTH-52,bottom-12),muted);}
            auto terminal=[&](size_t i){return messages[i].value("images",Json::array()).empty()&&(i+1==messages.size()||messages[i].value("role","")!=messages[i+1].value("role",""));};
            auto transcript=[&](float y,bool draw){const float origin=y;for(size_t i=0;i<messages.size();++i){const auto& m=messages[i];const bool user=m.value("role","")=="user";
                if(!m.value("text","").empty())y+=chatBubble(brush,m.value("text",""),y,user,draw,terminal(i));
                y+=messageImages(brush,m.value("images",Json::array()),y,user,draw,top,bottom);
            }return y-origin;};
            const float total=transcript(0,false);
            if(model.detailFollow)model.detailOffset=1000000;
            model.detailOffset=std::clamp(model.detailOffset,0,std::max(0,static_cast<int>(std::ceil((total-bottom+top)/32))));
            canvas->PushAxisAlignedClip(D2D1::RectF(CHAT_LEFT,top,WIDTH-28,bottom),D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
            transcript(top-model.detailOffset*32.0f,true);
            canvas->PopAxisAlignedClip();
            if(model.detailOffset<std::max(0,static_cast<int>(std::ceil((total-bottom+top)/32))))circleButton(brush,D2D1::Point2F(WIDTH-46,composeY()-25),"sourceLatest");
            if(!card.value("done",false)&&model.canDraft())composerPaint(brush);
        } else {
            label("Choose a conversation",24,D2D1::RectF(CHAT_LEFT+24,216,WIDTH-36,264),chatstyle::ink(),DWRITE_FONT_WEIGHT_SEMI_BOLD);
            label("Select a chat on the left, or talk to Hyphen.",15,D2D1::RectF(CHAT_LEFT+24,280,WIDTH-36,330),muted);
        }
        noticePaint(brush);
    }
    void capture(const std::filesystem::path& path) {
        Com<ID3D11Texture2D> source;require(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),reinterpret_cast<void**>(source.put())),"Capture buffer");
        D3D11_TEXTURE2D_DESC description{};source->GetDesc(&description);
        description.Usage=D3D11_USAGE_STAGING;description.BindFlags=0;description.CPUAccessFlags=D3D11_CPU_ACCESS_READ;description.MiscFlags=0;
        Com<ID3D11Texture2D> copy;require(gpu->CreateTexture2D(&description,nullptr,copy.put()),"Capture texture");
        Com<ID3D11DeviceContext> context;gpu->GetImmediateContext(context.put());context->CopyResource(copy.get(),source.get());
        D3D11_MAPPED_SUBRESOURCE pixels{};require(context->Map(copy.get(),0,D3D11_MAP_READ,0,&pixels),"Capture pixels");
        try {
            Com<IWICImagingFactory> factory;require(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,
                __uuidof(IWICImagingFactory),reinterpret_cast<void**>(factory.put())),"Capture factory");
            Com<IWICStream> stream;require(factory->CreateStream(stream.put()),"Capture stream");
            require(stream->InitializeFromFilename(path.c_str(),GENERIC_WRITE),"Capture file");
            Com<IWICBitmapEncoder> encoder;require(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()),"Capture encoder");
            require(encoder->Initialize(stream.get(),WICBitmapEncoderNoCache),"Capture initialize");
            Com<IWICBitmapFrameEncode> frame;require(encoder->CreateNewFrame(frame.put(),nullptr),"Capture frame");
            require(frame->Initialize(nullptr),"Capture frame initialize");require(frame->SetSize(description.Width,description.Height),"Capture size");
            WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;require(frame->SetPixelFormat(&format),"Capture format");
            require(frame->WritePixels(description.Height,pixels.RowPitch,pixels.RowPitch*description.Height,
                static_cast<BYTE*>(pixels.pData)),"Capture write");
            require(frame->Commit(),"Capture frame commit");require(encoder->Commit(),"Capture commit");
        } catch(...) {context->Unmap(copy.get(),0);throw;}
        context->Unmap(copy.get(),0);
    }
    void curve(const Motion& motion, float scale, float offset, Com<IDCompositionAnimation>& animation) {
        require(compositor->CreateAnimation(animation.put()), "CreateAnimation");
        constexpr int segments=24;
        for(int i=0; i<segments; ++i) {
            const double t=i*Motion::duration/segments, h=Motion::duration/segments;
            const auto a=motion.at(motion.startTime+t), b=motion.at(motion.startTime+t+h);
            const double delta=b.position-a.position;
            const double c2=3*delta/(h*h)-(2*a.velocity+b.velocity)/h;
            const double c3=-2*delta/(h*h*h)+(a.velocity+b.velocity)/(h*h);
            require(animation->AddCubic(t, static_cast<float>(offset+scale*a.position),
                static_cast<float>(scale*a.velocity), static_cast<float>(scale*c2), static_cast<float>(scale*c3)), "AddCubic");
        }
        require(animation->End(Motion::duration, static_cast<float>(offset+scale*motion.target)), "AnimationEnd");
    }
    void animate(const Motion& motion) {
        Com<IDCompositionAnimation> position, alpha;
        curve(motion, WIDTH*dpi/96, -WIDTH*dpi/96, position);
        curve(motion, 1, 0, alpha);
        require(visual->SetOffsetX(position.get()), "SetOffsetX");
        require(opacity->SetOpacity(alpha.get()), "SetOpacity");
        require(compositor->Commit(), "Commit"); ++commits;
    }
    void settle(bool visible) {
        require(visual->SetOffsetX(visible?0.0f:-WIDTH*dpi/96), "SetOffsetX");
        require(opacity->SetOpacity(visible?1.0f:0.0f), "SetOpacity");
        require(compositor->Commit(), "Commit"); ++commits;
    }
};

LRESULT CALLBACK editProc(HWND,UINT,WPARAM,LPARAM);
LRESULT CALLBACK searchProc(HWND,UINT,WPARAM,LPARAM);
struct App {
    HWND panel=nullptr, trigger=nullptr, testTarget=nullptr;
    HWND tooltip=nullptr;
    std::wstring tooltipText;
    std::string tooltipKey;
    CanvasAccessible* accessible=nullptr;
    Com<IAccPropServices> accessibleProps;
    HWND editor=nullptr;
    HWND searchEditor=nullptr;
    HWND menuReturnFocus=nullptr;
    DWORD menuSelectionStart=0,menuSelectionEnd=0;
    bool pointerPressed=false,pressOutsideMenu=false;
    std::string composerPressKey;
    int composerLines=1,composerLinePixels=20;
    HFONT editorFont=nullptr;
    HFONT searchFont=nullptr;
    HBRUSH editorBrush=nullptr;
    HBRUSH searchBrush=nullptr;
    WNDPROC originalEditProc=nullptr;
    WNDPROC originalSearchProc=nullptr;
    std::string editorSource;
    bool syncingEditor=false, composing=false, suppressEnterChar=false,focusComposerRequested=false;
    float auditDpi=0;bool auditReducedMotion=false;
    Renderer renderer;
    Bridge bridge;
    QueueClient queueClient;
    InputGuard input;
    Motion motion;
    Mode mode=Mode::Hidden;
    bool trackedTrigger=false, trackedPanel=false, suppressed=false, closing=false;
    bool leaveTimer=false, finishTimer=false;
    unsigned reveals=0;
    unsigned weatherCommands=0,commandReplies=0;
    bool weatherAvailable=false, weatherInside=false, hoverTimer=false;
    bool taskbarAdapter=true, adapterReady=false,allowAdapterAttach=true;
    HANDLE adapterControl=nullptr;
    taskbar::Endpoint adapterEndpoint{};
    HWINEVENTHOOK foregroundHook=nullptr, reorderHook=nullptr;
    UINT taskbarCreated=0;
    NOTIFYICONDATAW tray{};
    RECT triggerRect{}, workArea{};
    POINT savedPosition{};
    std::filesystem::path tracePath,capturePath,draftPath,auditCapturePath;
    std::vector<std::filesystem::path> temporaryImages;
    bool saveDrafts() {
        if(draftPath.empty())return false;
        try {
            Json values=Json::object();for(const auto& [source,value]:renderer.model.drafts)if(!value.empty())values[source]=value;
            Json ids=renderer.model.intentIds;
            auto temp=draftPath;temp+=L".tmp";std::ofstream out(temp,std::ios::binary|std::ios::trunc);out<<Json({{"version",3},{"drafts",values},{"intentIds",ids},{"attachments",renderer.model.attachments}}).dump();out.close();
            if(!out||!MoveFileExW(temp.c_str(),draftPath.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("Draft storage failed");
            return true;
        }catch(const std::exception& e){error(e);renderer.model.message="Draft could not be saved. Keep this window open.";return false;}
    }
    int px(float value) const { return static_cast<int>(std::round(value*renderer.dpi/96)); }
    const char* name() const { return mode==Mode::Hidden?"hidden":mode==Mode::Peek?"peek":"pinned"; }
    void log(const char* event) {
        PROCESS_MEMORY_COUNTERS_EX memory{}; memory.cb=sizeof(memory);
        GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory));
        RECT r{}; if(panel) GetWindowRect(panel,&r);
        std::ofstream out(tracePath, std::ios::app);
        out << "{\"event\":\"" << event << "\",\"mode\":\"" << name()
            << "\",\"pid\":" << GetCurrentProcessId() << ",\"seconds\":" << std::fixed << std::setprecision(3) << clockSeconds()
            << ",\"surfaceDraws\":" << renderer.draws << ",\"animationCommits\":" << renderer.commits
            << ",\"commandReplies\":" << commandReplies
            << ",\"queueConnected\":" << (renderer.model.connected?"true":"false")
            << ",\"queueCards\":" << renderer.model.cards().size()
            << ",\"sidebarOffset\":" << renderer.model.offset
            << ",\"searchLength\":" << renderer.model.search.size()
            << ",\"menuOpen\":" << (!renderer.popover.empty()?"true":"false")
            << ",\"pointerPressed\":" << (pointerPressed?"true":"false")
            << ",\"assistantFollow\":" << (renderer.model.assistantFollow?"true":"false")
            << ",\"composerHeight\":" << renderer.composerHeight
            << ",\"conversationOffset\":" << (renderer.model.chatting()?renderer.model.assistantOffset:renderer.model.detailOffset)
            << ",\"selected\":" << (!renderer.model.selectedId.empty()?"true":"false")
            << ",\"pending\":" << (renderer.model.pending?"true":"false")
            << ",\"detailPending\":" << (renderer.model.detailPending?"true":"false")
            << ",\"lastPaintMs\":" << renderer.paintMs
            << ",\"cachedChats\":" << renderer.model.recent.size()
            << ",\"loadingImages\":" << renderer.loadingImages.size()
            << ",\"composerKey\":\"" << renderer.model.composerKey() << "\""
            << ",\"composerVisible\":" << (IsWindowVisible(editor)?"true":"false")
            << ",\"replyPending\":" << (!renderer.model.pendingSend.empty()?"true":"false")
            << ",\"hasDraft\":" << (renderer.model.hasDraft()?"true":"false")
            << ",\"draftImages\":" << renderer.model.images().size()
            << ",\"queuedMessages\":" << renderer.model.currentSource().value("queuedMessages",0)
            << ",\"assistantView\":" << (renderer.model.chatting()?"true":"false")
            << ",\"assistantMessages\":" << renderer.model.state.value("assistant",Json::object()).value("messages",Json::array()).size()
            << ",\"assistantResponding\":" << (renderer.model.state.value("assistant",Json::object()).value("responding",false)?"true":"false")
            << ",\"cornerCoordinated\":" << (bridge.connected?"true":"false")
            << ",\"weatherGuard\":" << (input.hook?"true":"false") << ",\"weatherCommands\":" << weatherCommands
            << ",\"taskbarAdapter\":" << (taskbarAdapter?"true":"false") << ",\"adapterReady\":" << (adapterReady?"true":"false")
            << ",\"weatherAvailable\":" << (weatherAvailable?"true":"false")
            << ",\"adapterAutoAttach\":" << (allowAdapterAttach?"true":"false")
            << ",\"panelVisible\":" << (IsWindowVisible(panel)?"true":"false")
            << ",\"triggerVisible\":" << (IsWindowVisible(trigger)?"true":"false")
            << ",\"reveals\":" << reveals << ",\"timers\":" << (leaveTimer+finishTimer+hoverTimer)
            << ",\"workingSetBytes\":" << memory.WorkingSetSize << ",\"privateBytes\":" << memory.PrivateUsage
            << ",\"panel\":[" << r.left << ',' << r.top << ',' << r.right-r.left << ',' << r.bottom-r.top
            << "],\"trigger\":[" << triggerRect.left << ',' << triggerRect.top << ',' << triggerRect.right-triggerRect.left
            << ',' << triggerRect.bottom-triggerRect.top << "]}\n";
    }
    void stopLeave() { KillTimer(panel,TIMER_LEAVE); leaveTimer=false; }
    void error(const std::exception& error) {
        std::ofstream out(tracePath,std::ios::app);
        out<<"{\"event\":\"exception\",\"detail\":"<<std::quoted(error.what())<<"}\n";
    }
    void attachAdapter() {
        if(!taskbarAdapter || !allowAdapterAttach || adapterControl)return;
        wchar_t own[32768]{}; GetModuleFileNameW(nullptr,own,32768);
        const auto control=(std::filesystem::path(own).parent_path()/L"Taskbar Adapter Control.exe").wstring();
        std::wstring command=L"\""+control+L"\" --attach";
        STARTUPINFOW startup{}; startup.cb=sizeof(startup); startup.dwFlags=STARTF_USESHOWWINDOW; startup.wShowWindow=SW_HIDE;
        PROCESS_INFORMATION process{};
        if(!CreateProcessW(control.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process))
            throw std::runtime_error("Could not start the taskbar adapter controller");
        CloseHandle(process.hThread); adapterControl=process.hProcess;
    }
    void initComposer() {
        editorBrush=CreateSolidBrush(chatstyle::editorBackground);
        editorFont=CreateFontW(-px(chatlayout::composerSize),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,ANTIALIASED_QUALITY,DEFAULT_PITCH,chatstyle::font);
        // The composition-only parent has no GDI redirection bitmap. Give each
        // real text field its own small redirected surface above that parent.
        editor=CreateWindowExW(WS_EX_LAYERED,L"EDIT",L"",WS_CHILD|WS_TABSTOP|ES_MULTILINE|ES_AUTOVSCROLL|ES_WANTRETURN,
            px(chatlayout::composerTextLeft),px(COMPOSER_TOP+chatlayout::composerPadding),px(chatlayout::composerTextWidth),px(chatlayout::composerMinHeight-2*chatlayout::composerPadding),panel,reinterpret_cast<HMENU>(REPLY_EDIT),GetModuleHandleW(nullptr),nullptr);
        if(!editor||!editorFont||!editorBrush)throw std::runtime_error("Reply editor creation failed");
        if(!SetLayeredWindowAttributes(editor,0,255,LWA_ALPHA))throw std::runtime_error("Reply editor redirection failed");
        SendMessageW(editor,WM_SETFONT,reinterpret_cast<WPARAM>(editorFont),FALSE);
        SendMessageW(editor,EM_SETMARGINS,EC_LEFTMARGIN|EC_RIGHTMARGIN,MAKELPARAM(px(chatlayout::composerMargin),px(chatlayout::composerMargin)));
        renderer.composerEditor=editor;
        SendMessageW(editor,EM_SETLIMITTEXT,12000,0);
        originalEditProc=reinterpret_cast<WNDPROC>(SetWindowLongPtrW(editor,GWLP_WNDPROC,reinterpret_cast<LONG_PTR>(editProc)));
        if(!originalEditProc)throw std::runtime_error("Reply editor input setup failed");
        searchBrush=CreateSolidBrush(chatstyle::searchBackground);
        searchFont=CreateFontW(-px(13),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,ANTIALIASED_QUALITY,DEFAULT_PITCH,chatstyle::font);
        searchEditor=CreateWindowExW(WS_EX_LAYERED,L"EDIT",L"",WS_CHILD|WS_TABSTOP|ES_AUTOHSCROLL,
            px(chatlayout::searchLeft+20),px(chatlayout::searchTop),px(chatlayout::searchWidth-20),px(22),panel,reinterpret_cast<HMENU>(SEARCH_EDIT),GetModuleHandleW(nullptr),nullptr);
        if(!searchEditor||!searchFont||!searchBrush)throw std::runtime_error("Search editor creation failed");
        if(!SetLayeredWindowAttributes(searchEditor,0,255,LWA_ALPHA))throw std::runtime_error("Search editor redirection failed");
        SendMessageW(searchEditor,WM_SETFONT,reinterpret_cast<WPARAM>(searchFont),FALSE);SendMessageW(searchEditor,EM_SETLIMITTEXT,2048,0);
        originalSearchProc=reinterpret_cast<WNDPROC>(SetWindowLongPtrW(searchEditor,GWLP_WNDPROC,reinterpret_cast<LONG_PTR>(searchProc)));
        if(!originalSearchProc)throw std::runtime_error("Search input setup failed");
        require(CoCreateInstance(CLSID_AccPropServices,nullptr,CLSCTX_INPROC_SERVER,IID_IAccPropServices,reinterpret_cast<void**>(accessibleProps.put())),"Accessible field names");
        require(accessibleProps->SetHwndPropStr(editor,OBJID_CLIENT,CHILDID_SELF,PROPID_ACC_NAME,L"Message"),"Message field name");
        require(accessibleProps->SetHwndPropStr(searchEditor,OBJID_CLIENT,CHILDID_SELF,PROPID_ACC_NAME,L"Search chats and tasks"),"Search field name");
        accessible=new CanvasAccessible(panel,[this]{return accessibleItems();});
        INITCOMMONCONTROLSEX controls{sizeof(controls),ICC_WIN95_CLASSES};InitCommonControlsEx(&controls);
        tooltip=CreateWindowExW(WS_EX_TOPMOST,TOOLTIPS_CLASSW,nullptr,WS_POPUP|TTS_NOPREFIX|TTS_ALWAYSTIP,CW_USEDEFAULT,CW_USEDEFAULT,CW_USEDEFAULT,CW_USEDEFAULT,panel,nullptr,GetModuleHandleW(nullptr),nullptr);
        if(tooltip){TOOLINFOW tool{};tool.cbSize=sizeof(tool);tool.uFlags=TTF_SUBCLASS;tool.hwnd=panel;tool.uId=1;GetClientRect(panel,&tool.rect);tool.lpszText=const_cast<wchar_t*>(L"");SendMessageW(tooltip,TTM_ADDTOOLW,0,reinterpret_cast<LPARAM>(&tool));SendMessageW(tooltip,TTM_SETMAXTIPWIDTH,0,px(440));SendMessageW(tooltip,TTM_SETDELAYTIME,TTDT_INITIAL,500);}
    }
    std::string hitName(const Hit& hit) const {
        const auto& a=hit.action;
        if(a=="card")return hit.card.value("chatName","")+" · "+hit.card.value("title","")+" · "+hit.card.value("label","")+" · "+hit.card.value("summaryNotice","");
        if(a=="send")return renderer.model.defaultQueue()?"Queue message after this pass":"Send message";
        if(a=="close")return "Hide Hyphen";
        if(a=="detailsMenu")return "Conversation details";
        if(a=="filterMenu")return "Filter conversations";
        if(a=="addMenu")return "Message options";
        if(a=="assistant")return "Talk to Hyphen";
        if(a=="removeImage")return "Remove image · "+hit.card.value("name",std::string("attachment"));
        if(a=="openImage")return "Open image · "+hit.card.value("name",std::string("attachment"));
        if(a=="retryDetails")return "Retry loading messages";
        if(a=="assistantUse")return "Open related update or draft";
        if(a=="done")return "Mark task done";
        if(a=="reopen")return "Reopen task";
        const std::map<std::string,std::string> names{{"tab0","Updates"},{"tab1","Queued"},{"tab2","History"},{"tab3","Done"},{"previous","Previous chats"},{"next","Next chats"},{"clearSearch","Clear search"},{"chatLatest","Latest message"},{"sourceLatest","Latest message"},{"attach","Add image"},{"queue","Queue next reply"},{"sendNow","Send now"},{"copyMessage","Copy message"},{"open","Open chat in Codex"},{"reviewed","Reviewed"},{"snooze","Snooze one hour"},{"undo","Undo last action"},{"clearQueue","Clear queued messages"},{"checked","Checked reply"},{"memory","Memory"},{"askNeeds","What needs me?"},{"askChanges","What changed?"},{"browse","Include older chats"},{"source","Switch source"}};
        auto found=names.find(a);return found==names.end()?a:found->second;
    }
    std::string hitDescription(const Hit& hit) const {
        if(hit.enabled)return hit.action=="send"?"Enter in Message sends or queues; Shift+Enter starts a new line.":"";
        if(!renderer.model.connected)return "Reconnecting. Your draft is saved.";
        if(renderer.model.pending)return "A submission is still finishing. You can switch chats and keep writing.";
        if(hit.action=="send")return renderer.model.hasDraft()?"Wait for this reply to finish or check the conversation error.":"Write a message or add an image first.";
        if(hit.action=="attach")return "Up to four images per message.";
        return "Unavailable in the current conversation state.";
    }
    RECT screenBox(D2D1_RECT_F value) const {POINT origin{};ClientToScreen(panel,&origin);return {origin.x+px(value.left),origin.y+px(value.top),origin.x+px(value.right),origin.y+px(value.bottom)};}
    std::vector<AccessibleItem> accessibleItems() const {
        std::vector<AccessibleItem> items;if(closing)return items;
        for(HWND field:{editor,searchEditor})if(field&&IsWindowVisible(field)){AccessibleItem i;i.key=field==editor?"editor":"search";i.name=field==editor?L"Message":L"Search chats and tasks";i.role=ROLE_SYSTEM_TEXT;i.state=STATE_SYSTEM_FOCUSABLE|(GetFocus()==field?STATE_SYSTEM_FOCUSED:0)|((GetWindowLongW(field,GWL_STYLE)&ES_READONLY)?STATE_SYSTEM_READONLY:0);GetWindowRect(field,&i.box);i.child=field;items.push_back(i);}
        for(size_t n=0;n<renderer.hits.size();++n){const auto& hit=renderer.hits[n];AccessibleItem i;i.key=Renderer::hitKey(hit);i.name=wide(hitName(hit));i.description=wide(hitDescription(hit));i.role=hit.action=="card"?ROLE_SYSTEM_LISTITEM:ROLE_SYSTEM_PUSHBUTTON;i.state=STATE_SYSTEM_FOCUSABLE|(hit.enabled?0:STATE_SYSTEM_UNAVAILABLE);if(!IsWindowVisible(panel))i.state|=STATE_SYSTEM_INVISIBLE;if(renderer.focused==static_cast<int>(n)&&GetFocus()==panel)i.state|=STATE_SYSTEM_FOCUSED;if(hit.action=="card"&&hit.card.value("id","")==renderer.model.selectedId&&hit.card.value("taskKey","")==renderer.model.selectedKey)i.state|=STATE_SYSTEM_SELECTED;i.box=screenBox(hit.box);items.push_back(i);}
        for(size_t n=0;n<renderer.messageTargets.size();++n){const auto& m=renderer.messageTargets[n];AccessibleItem i;i.key="message:"+renderer.model.composerKey()+":"+m.card.value("text","")+":"+std::to_string(n);i.name=wide(m.card.value("text",""));i.role=ROLE_SYSTEM_STATICTEXT;i.state=STATE_SYSTEM_READONLY;i.box=screenBox(m.box);items.push_back(i);}
        if(!renderer.notice.empty()){AccessibleItem i;i.key="status";i.name=wide(renderer.notice);i.role=ROLE_SYSTEM_STATICTEXT;i.state=STATE_SYSTEM_READONLY;i.box=screenBox(D2D1::RectF(CHAT_LEFT+38,renderer.noticeBottom()-renderer.noticeHeight,WIDTH-80,renderer.noticeBottom()));items.push_back(i);}
        return items;
    }
    void accessibleAction(long id,bool focusOnly) {
        AccessibleItem item;if(!accessible||!accessible->item(id,item)||item.state&STATE_SYSTEM_UNAVAILABLE)return;
        if(focusOnly&&item.child){SetFocus(item.child);return;}
        for(size_t n=0;n<renderer.hits.size();++n)if(Renderer::hitKey(renderer.hits[n])==item.key&&renderer.hits[n].enabled){const auto box=renderer.hits[n].box;if(focusOnly){pin();renderer.focused=static_cast<int>(n);SetFocus(panel);renderer.paint();NotifyWinEvent(EVENT_OBJECT_FOCUS,panel,OBJID_CLIENT,id);}else click((box.left+box.right)/2,(box.top+box.bottom)/2);return;}
    }
    void updateTooltip() {
        if(!tooltip)return;const auto hit=renderer.pointerInside?renderer.hitAt(renderer.pointerX,renderer.pointerY):nullptr;
        const auto key=hit?Renderer::hitKey(*hit):std::string();if(key==tooltipKey)return;tooltipKey=key;
        SendMessageW(tooltip,TTM_POP,0,0);tooltipText=hit?wide(hitName(*hit)+(hitDescription(*hit).empty()?"":"\n"+hitDescription(*hit))):L"";
        TOOLINFOW tool{};tool.cbSize=sizeof(tool);tool.hwnd=panel;tool.uId=1;tool.lpszText=tooltipText.data();tool.rect=hit?RECT{px(hit->box.left),px(hit->box.top),px(hit->box.right),px(hit->box.bottom)}:RECT{};
        SendMessageW(tooltip,TTM_NEWTOOLRECTW,0,reinterpret_cast<LPARAM>(&tool));SendMessageW(tooltip,TTM_UPDATETIPTEXTW,0,reinterpret_cast<LPARAM>(&tool));
    }
    std::wstring editorText() const {
        std::wstring value(GetWindowTextLengthW(editor)+1,0);
        value.resize(GetWindowTextW(editor,value.data(),static_cast<int>(value.size())));return value;
    }
    void syncComposer() {
        if(!editor)return;
        auto& model=renderer.model;
        const auto draft=wide(model.draft());
        if(editorSource!=model.composerKey() || editorText()!=draft) {
            syncingEditor=true;editorSource=model.composerKey();SetWindowTextW(editor,draft.c_str());
            SendMessageW(editor,EM_SETSEL,draft.size(),draft.size());syncingEditor=false;
        }
        const bool visible=mode!=Mode::Hidden&&model.canDraft();
        SendMessageW(editor,EM_SETLIMITTEXT,model.chatting()?4000:12000,0);
        SendMessageW(editor,EM_SETREADONLY,!model.canDraft(),0);
        layoutEditors();
        ShowWindow(editor,visible&&!finishTimer&&renderer.popover.empty()?SW_SHOWNA:SW_HIDE);
        if(searchEditor)ShowWindow(searchEditor,mode!=Mode::Hidden&&!finishTimer&&renderer.popover.empty()?SW_SHOWNA:SW_HIDE);
    }
    void layoutEditors() {
        if(editor) {
            const auto position=[this] {
                RECT actual{};GetWindowRect(editor,&actual);MapWindowPoints(nullptr,panel,reinterpret_cast<POINT*>(&actual),2);
                const int x=px(chatlayout::composerTextLeft),y=px(renderer.composeY()+chatlayout::composerPadding),w=px(chatlayout::composerTextWidth),h=px(renderer.composerHeight-2*chatlayout::composerPadding);
                if(actual.left==x&&actual.top==y&&actual.right-actual.left==w&&actual.bottom-actual.top==h)return false;
                SetWindowPos(editor,nullptr,x,y,w,h,SWP_NOZORDER|SWP_NOACTIVATE);return true;
            };
            // Resize to the final width before querying EDIT's own soft wraps.
            // DirectWrite's line metrics do not describe this native control.
            bool resized=position();
            HDC dc=GetDC(editor);TEXTMETRICW metrics{};
            if(dc){const auto previous=SelectObject(dc,editorFont);if(GetTextMetricsW(dc,&metrics))composerLinePixels=metrics.tmHeight;SelectObject(dc,previous);ReleaseDC(editor,dc);}
            composerLines=std::max(1,static_cast<int>(SendMessageW(editor,EM_GETLINECOUNT,0,0)));
            renderer.composerHeight=std::clamp(composerLines*composerLinePixels*96/renderer.dpi+2*chatlayout::composerPadding,chatlayout::composerMinHeight,chatlayout::composerMaxHeight);
            resized=position()||resized;if(resized)SendMessageW(editor,EM_SCROLLCARET,0,0);
        }
        if(searchEditor)SetWindowPos(searchEditor,nullptr,px(chatlayout::searchLeft+20),px(chatlayout::searchTop),px(chatlayout::searchWidth-(renderer.model.search.empty()?20:42)),px(22),SWP_NOZORDER|SWP_NOACTIVATE);
    }
    void searchChanged() {
        if(!searchEditor)return;std::wstring value(GetWindowTextLengthW(searchEditor)+1,0);value.resize(GetWindowTextW(searchEditor,value.data(),static_cast<int>(value.size())));
        const auto query=utf8(value);if(query==renderer.model.search)return;
        renderer.model.search=query;renderer.model.offset=0;renderer.popover.clear();syncComposer();renderer.paint();log("ui-search");
    }
    void editChanged() {
        if(syncingEditor||editorSource.empty())return;
        renderer.model.draft(utf8(editorText()));
        if(!draftPath.empty())SetTimer(panel,TIMER_DRAFT,350,nullptr);
        renderer.model.message.clear();renderer.model.notices.erase(renderer.model.composerKey());
        layoutEditors();
        renderer.paint();
    }
    void attach(Json paths) {
        auto& model=renderer.model;if(!model.canDraft())return;
        if(model.pending){model.message="An action is still finishing. Your image has not been added yet.";renderer.paint();return;}
        if(!model.connected){model.message="Reconnect before adding images. Your existing draft is saved.";renderer.paint();return;}
        if(paths.empty()||paths.size()+model.images().size()>4){model.message="Attach up to four images per message.";renderer.paint();return;}
        pin();send("attachImages",{{"paths",paths},{"composerKey",model.composerKey()}});
    }
    void chooseImages() {
        pin();wchar_t files[32768]{};OPENFILENAMEW picker{};picker.lStructSize=sizeof(picker);picker.hwndOwner=panel;
        picker.lpstrFilter=L"Images (PNG, JPEG, WebP, GIF)\0*.png;*.jpg;*.jpeg;*.webp;*.gif\0\0";picker.lpstrFile=files;picker.nMaxFile=32768;
        picker.lpstrTitle=L"Attach images";picker.Flags=OFN_EXPLORER|OFN_ALLOWMULTISELECT|OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
        if(!GetOpenFileNameW(&picker)){if(CommDlgExtendedError()){renderer.model.message="Image picker could not open. Try pasting or dropping an image.";renderer.paint();}return;}
        Json paths=Json::array();auto first=std::filesystem::path(files);auto next=files+wcslen(files)+1;
        if(!*next)paths.push_back(utf8(first.wstring()));else for(auto at=next;*at;at+=wcslen(at)+1){paths.push_back(utf8((first/at).wstring()));if(paths.size()>4)break;}
        attach(paths);
    }
    bool pasteImage() {
        if(!renderer.model.canDraft())return false;
        if(!renderer.model.connected)return false;
        const UINT png=RegisterClipboardFormatW(L"PNG");
        if(!IsClipboardFormatAvailable(png)&&!IsClipboardFormatAvailable(CF_BITMAP))return false;
        if(renderer.model.pending){renderer.model.message="An action is still finishing. Your image has not been added yet.";renderer.paint();return true;}
        if(renderer.model.images().size()>=4){renderer.model.message="Up to four images per message.";renderer.paint();return true;}
        if(!OpenClipboard(panel)){renderer.model.message="Clipboard is busy. Try pasting again.";renderer.paint();return true;}
        std::filesystem::path file;
        try {
            GUID guid;wchar_t id[40]{},temp[32768]{};require(CoCreateGuid(&guid),"Clipboard identity");StringFromGUID2(guid,id,40);GetTempPathW(32768,temp);
            file=std::filesystem::path(temp)/(std::wstring(L"hyphen-image-")+id+L".png");
            if(IsClipboardFormatAvailable(png)) {
                auto handle=GetClipboardData(png);SIZE_T size=GlobalSize(handle);if(!size||size>20*1024*1024)throw std::runtime_error("Clipboard image must be smaller than 20 MB");
                auto bytes=GlobalLock(handle);if(!bytes)throw std::runtime_error("Clipboard image unavailable");
                std::ofstream out(file,std::ios::binary);out.write(static_cast<const char*>(bytes),size);GlobalUnlock(handle);out.close();if(!out)throw std::runtime_error("Clipboard image could not be saved");
            }else {
                auto bitmap=reinterpret_cast<HBITMAP>(GetClipboardData(CF_BITMAP));BITMAP info{};if(!bitmap||!GetObjectW(bitmap,sizeof(info),&info)||static_cast<uint64_t>(info.bmWidth)*std::abs(info.bmHeight)>50000000)throw std::runtime_error("Clipboard image is too large");
                Com<IWICBitmap> image;require(renderer.imaging->CreateBitmapFromHBITMAP(bitmap,nullptr,WICBitmapUseAlpha,image.put()),"Clipboard bitmap");
                Com<IWICStream> stream;require(renderer.imaging->CreateStream(stream.put()),"Clipboard stream");require(stream->InitializeFromFilename(file.c_str(),GENERIC_WRITE),"Clipboard file");
                Com<IWICBitmapEncoder> encoder;require(renderer.imaging->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()),"Clipboard encoder");require(encoder->Initialize(stream.get(),WICBitmapEncoderNoCache),"Clipboard encoder initialize");
                Com<IWICBitmapFrameEncode> frame;require(encoder->CreateNewFrame(frame.put(),nullptr),"Clipboard frame");require(frame->Initialize(nullptr),"Clipboard frame initialize");require(frame->WriteSource(image.get(),nullptr),"Clipboard encode");require(frame->Commit(),"Clipboard frame commit");require(encoder->Commit(),"Clipboard image commit");
            }
            CloseClipboard();temporaryImages.push_back(file);attach(Json::array({utf8(file.wstring())}));
        }catch(...) {CloseClipboard();if(!file.empty()){std::error_code ec;std::filesystem::remove(file,ec);}renderer.model.message="Image could not be pasted. Use + Image to choose it.";renderer.paint();}
        return true;
    }
    void reply(bool queue=false) {
        auto& model=renderer.model;
        if(!model.canReply()||!model.hasDraft())return;
        const auto key=model.composerKey();
        if(!model.intentIds.contains(key)){
            GUID guid;wchar_t value[40]{};if(FAILED(CoCreateGuid(&guid))||!StringFromGUID2(guid,value,40)){model.message="Could not create message identity.";renderer.paint();return;}
            model.intentIds[key]=utf8(std::wstring(value+1,36));
        }
        if(!saveDrafts()){model.message="Save the draft before sending. Draft storage is unavailable.";renderer.paint();return;}
        auto input=model.replyInput();model.pendingSend=input;
        if(model.chatting()){model.assistantFollow=true;model.assistantOffset=1000000;}
        else{model.detailFollow=true;model.detailOffset=1000000;}
        send(model.chatting()?"assistantAsk":queue?"queueMessage":"send",input);
        if(!model.pending)model.pendingSend=Json::object();
        syncComposer();log("reply-submitted");
    }
    void send(std::string method,Json input=Json::object()) {
        auto& model=renderer.model;
        if(model.pending)return;
        model.message.clear();model.notices.erase(model.composerKey());model.pendingOwner=model.composerKey();model.pendingCommand=method;model.pending=queueClient.command(method,std::move(input));
        if(!model.pending){model.pendingCommand.clear();model.message="Queue is not connected.";}
        syncComposer();
        renderer.paint();
    }
    void requestDetails(bool force=false) {
        auto& model=renderer.model;
        if(!model.connected||model.selectedId.empty()||(!force&&(model.detailPending||!model.detailError.empty()||!model.detailNeeded())))return;
        if(queueClient.details(model.beginDetails(GetTickCount64())))SetTimer(panel,TIMER_DETAILS,160,nullptr);
        else{model.detailPending=false;model.detailError="Messages could not load. Your draft is saved.";}
    }
    void queueEvents() {
        for(auto& event:queueClient.take()) {
            const auto type=event.value("event","");
            if(type=="state") {
                const bool reconnecting=!renderer.model.connected;
                renderer.model.connected=true;
                if(reconnecting)renderer.model.message.clear();
                if(renderer.model.state==event.at("state"))continue;
                renderer.model.update(event.at("state"));
            }
            else if(type=="details"){renderer.model.response(event);if(!renderer.model.detailPending)KillTimer(panel,TIMER_DETAILS);}
            else if(type=="command"){
                std::ofstream out(tracePath,std::ios::app);out<<Json({{"event","native.command"},{"command",event.value("command","")},{"ok",event.value("ok",false)},{"code",event.value("code",Json())}}).dump()<<'\n';
                ++commandReplies;renderer.model.response(event);saveDrafts();
                if(event.value("command","")=="attachImages") {renderer.unavailableImages.clear();for(const auto& file:temporaryImages){std::error_code ec;std::filesystem::remove(file,ec);}temporaryImages.clear();}
            }
            else {renderer.model.connected=false;renderer.model.message=event.value("error","Queue connection failed.");}
        }
        if(renderer.model.currentSource().value("contextLoaded",false))requestDetails();
        syncComposer();
        if(mode!=Mode::Hidden)renderer.paint();
        if(!capturePath.empty()) {renderer.paint(capturePath);capturePath.clear();}
        if(focusComposerRequested&&!renderer.model.pending){if(GetFocus()==panel&&mode==Mode::Pinned&&renderer.popover.empty()&&IsWindowVisible(editor))SetFocus(editor);focusComposerRequested=false;}
        log("queue-updated");
    }
    void openMenu(const std::string& kind) {
        if(tooltip)SendMessageW(tooltip,TTM_POP,0,0);tooltipKey.clear();
        if(renderer.popover.empty()){
            const auto focus=GetFocus();menuReturnFocus=focus==editor||focus==searchEditor?focus:IsWindowVisible(editor)?editor:panel;
            if(menuReturnFocus==editor||menuReturnFocus==searchEditor)SendMessageW(menuReturnFocus,EM_GETSEL,reinterpret_cast<WPARAM>(&menuSelectionStart),reinterpret_cast<LPARAM>(&menuSelectionEnd));
        }
        renderer.popover=kind;renderer.focused=-1;SetFocus(panel);syncComposer();renderer.paint();log("ui-menu");
    }
    void dismissMenu() {
        if(renderer.popover.empty())return;
        renderer.popover.clear();renderer.focused=-1;syncComposer();renderer.paint();
        if(menuReturnFocus&&IsWindowVisible(menuReturnFocus)){
            SetFocus(menuReturnFocus);if(menuReturnFocus==editor||menuReturnFocus==searchEditor)SendMessageW(menuReturnFocus,EM_SETSEL,menuSelectionStart,menuSelectionEnd);
        }
        menuReturnFocus=nullptr;log("ui-menu-dismissed");
    }
    void pointerMove(float x,float y,bool inside=true) {
        const auto before=renderer.pointerKey();renderer.pointerX=x;renderer.pointerY=y;renderer.pointerInside=inside&&x>=0&&y>=0&&x<=WIDTH&&y<=HEIGHT;
        if(before!=renderer.pointerKey())renderer.paint();
        updateTooltip();
    }
    void cancelPress() {
        if(!pointerPressed)return;pointerPressed=false;pressOutsideMenu=false;composerPressKey.clear();renderer.pressedKey.clear();renderer.paint();log("ui-press-cancelled");
    }
    bool composerAt(float x,float y) const {
        return renderer.popover.empty()&&IsWindowVisible(editor)&&renderer.model.canDraft()&&x>=chatlayout::composerLeft&&x<chatlayout::sendTargetLeft&&y>=renderer.composeY()&&y<=HEIGHT-22;
    }
    void focusComposerAt(float x,float y) {
        if(!composerAt(x,y))return;
        SetFocus(editor);
        RECT format{};SendMessageW(editor,EM_GETRECT,0,reinterpret_cast<LPARAM>(&format));
        const int cx=static_cast<int>(std::clamp<LONG>(px(x-chatlayout::composerTextLeft),format.left,std::max(format.left,format.right-1)));
        const int cy=static_cast<int>(std::clamp<LONG>(px(y-renderer.composeY()-chatlayout::composerPadding),format.top,std::max(format.top,format.bottom-1)));
        // Let EDIT place its own caret, including soft wraps and scroll offset.
        SendMessageW(editor,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(cx,cy));
        SendMessageW(editor,WM_LBUTTONUP,0,MAKELPARAM(cx,cy));
        log("composer-focus");
    }
    void pointerDown(float x,float y) {
        pin();renderer.pointerX=x;renderer.pointerY=y;renderer.pointerInside=x>=0&&y>=0&&x<=WIDTH&&y<=HEIGHT;pointerPressed=true;renderer.pressedKey=renderer.pointerKey();pressOutsideMenu=!renderer.popover.empty()&&renderer.pressedKey.empty();
        composerPressKey=renderer.pressedKey.empty()&&composerAt(x,y)?renderer.model.composerKey():std::string();
        if(!composerPressKey.empty())SetFocus(editor);
        SetCapture(panel);if(composerPressKey.empty())renderer.paint();log("ui-press");
    }
    void pointerUp(float x,float y) {
        if(!pointerPressed)return;renderer.pointerX=x;renderer.pointerY=y;renderer.pointerInside=x>=0&&y>=0&&x<=WIDTH&&y<=HEIGHT;
        const auto expected=renderer.pressedKey;const bool same=!expected.empty()&&expected==renderer.pointerKey();const bool dismiss=pressOutsideMenu&&renderer.pointerKey().empty();
        const bool composer=!composerPressKey.empty()&&composerPressKey==renderer.model.composerKey()&&renderer.pointerKey().empty()&&composerAt(x,y);
        pointerPressed=false;pressOutsideMenu=false;composerPressKey.clear();renderer.pressedKey.clear();if(GetCapture()==panel)ReleaseCapture();
        const auto before=renderer.draws;
        if(same)click(x,y);else if(dismiss)dismissMenu();else if(composer)focusComposerAt(x,y);else log("ui-press-cancelled");
        if(renderer.draws==before&&!composer)renderer.paint();
    }
    void contextMenu(float x,float y) {
        if(!renderer.popover.empty()){dismissMenu();return;}
        for(auto it=renderer.messageTargets.rbegin();it!=renderer.messageTargets.rend();++it)if(x>=it->box.left&&x<=it->box.right&&y>=it->box.top&&y<=it->box.bottom){
            renderer.copyText=it->card.value("text","");renderer.contextX=std::clamp(x,CHAT_LEFT,WIDTH-196);renderer.contextY=std::clamp(y,chatlayout::transcriptTop,renderer.composeY()-68);pin();openMenu("copy");return;
        }
    }
    bool copyMessage() {
        const auto value=wide(renderer.copyText);if(value.empty())return false;
        auto memory=GlobalAlloc(GMEM_MOVEABLE,(value.size()+1)*sizeof(wchar_t));if(!memory)return false;
        auto data=GlobalLock(memory);if(!data){GlobalFree(memory);return false;}memcpy(data,value.c_str(),(value.size()+1)*sizeof(wchar_t));GlobalUnlock(memory);
        if(!OpenClipboard(panel)){GlobalFree(memory);return false;}
        const bool copied=EmptyClipboard()&&SetClipboardData(CF_UNICODETEXT,memory);CloseClipboard();if(!copied)GlobalFree(memory);return copied;
    }
    void click(float x,float y) {
        pin();log("ui-click");auto& model=renderer.model;
        for(auto it=renderer.hits.rbegin();it!=renderer.hits.rend();++it)if(x>=it->box.left&&x<=it->box.right&&y>=it->box.top&&y<=it->box.bottom) {
            const auto& hit=*it;
            if(!hit.enabled)return;
            const std::string action=hit.action;const Json card=hit.card;
            if(action=="detailsMenu"||action=="filterMenu"||action=="addMenu"){
                openMenu(action=="detailsMenu"?"details":action=="filterMenu"?"filters":"add");return;
            }
            if(!renderer.popover.empty())dismissMenu();
            if(action=="close"){hide();return;}
            if(action=="clearSearch"){SetWindowTextW(searchEditor,L"");SetFocus(searchEditor);return;}
            if(action=="copyMessage"){if(!copyMessage()){model.message="Clipboard unavailable. Try Copy again.";renderer.paint();}renderer.copyText.clear();log("ui-copy");return;}
            if(action=="attach"){chooseImages();return;}
            if(action=="removeImage"){model.removeImage(card.value("id",""));saveDrafts();renderer.paint();return;}
            if(action=="openImage"){send("openAttachment",{{"attachmentId",card.value("id","")}});return;}
            if(action=="assistant") {queueClient.cancelDetails();model.back();model.view=4;model.message=model.notices.contains("@hyphen")?model.notices["@hyphen"]:"";syncComposer();renderer.paint();if(IsWindowVisible(editor))SetFocus(editor);log("ui-navigation");return;}
            if(action=="assistantBack"){model.view=0;model.message.clear();}
            else if(action=="chatLatest"){model.assistantFollow=true;model.assistantOffset=1000000;}
            else if(action=="sourceLatest"){model.detailFollow=true;model.detailOffset=1000000;}
            else if(action=="assistantUse"){focusComposerRequested=true;send("assistantUse",card);return;}
            else if(action=="memory"||action=="askNeeds"||action=="askChanges") {
                if(model.hasDraft()){model.message="Your draft is kept. Send it or clear it before using a suggestion.";renderer.paint();return;}
                model.draft(action=="memory"?"/memory":action=="askNeeds"?"What needs me right now?":"What changed recently in my chats?");reply();return;
            }
            if(action=="card") {queueClient.cancelDetails();model.choose(card);requestDetails();syncComposer();renderer.paint();if(IsWindowVisible(editor))SetFocus(editor);log("ui-navigation");return;}
            if(action=="retryDetails"){requestDetails(true);syncComposer();renderer.paint();return;}
            if(action=="back")model.back();
            else if(action.rfind("tab",0)==0) {model.back();model.view=action.back()-'0';model.offset=0;model.message.clear();}
            else if(action=="browse") {model.browseAll=!model.browseAll;model.offset=0;}
            else if(action=="previous")model.offset=std::max(0,model.offset-chatlayout::visibleRows);
            else if(action=="next")model.offset+=chatlayout::visibleRows;
            else if(action=="undo"){send("undo");return;}
            else if(action=="open"){send("open",model.input());return;}
            else if(action=="send"){reply(model.defaultQueue());return;}
            else if(action=="sendNow"){reply();return;}
            else if(action=="queue"){reply(true);return;}
            else if(action=="clearQueue"||action=="checked"){auto input=model.input();input["checked"]=action=="checked";send("clearMessages",input);return;}
            else if(action=="snooze"||action=="reviewed"||action=="done"||action=="reopen") {auto input=model.input();input["action"]=action;send("action",input);return;}
            else if(action=="source") {
                auto selected=model.selected();auto sources=selected.value("sources",Json::array());
                for(size_t i=0;i<sources.size();++i)if(sources[i].value("id","")==model.sourceId) {
                    model.sourceId=sources[(i+1)%sources.size()].value("id","");model.detailOffset=0;model.detailFollow=true;break;
                }
                queueClient.cancelDetails();model.detailPending=false;model.detailError.clear();++model.detailRequest;model.message=model.notices.contains(model.composerKey())?model.notices[model.composerKey()]:"";requestDetails();
            }
            syncComposer();renderer.paint();log("ui-navigation");return;
        }
        if(!renderer.popover.empty())dismissMenu();
    }
    void focusSearch() {if(!renderer.popover.empty())dismissMenu();pin();renderer.focused=-1;SetFocus(searchEditor);SendMessageW(searchEditor,EM_SETSEL,0,-1);renderer.paint();}
    void focusNext(bool reverse=false) {
        struct Stop {HWND window;int hit;};std::vector<Stop> stops;
        if(renderer.popover.empty()){if(IsWindowVisible(editor))stops.push_back({editor,-1});if(IsWindowVisible(searchEditor))stops.push_back({searchEditor,-1});}
        for(size_t i=0;i<renderer.hits.size();++i)if(renderer.hits[i].enabled)stops.push_back({panel,static_cast<int>(i)});
        if(stops.empty())return;
        int index=-1;for(size_t i=0;i<stops.size();++i)if(stops[i].window==GetFocus()&&(stops[i].window!=panel||stops[i].hit==renderer.focused)){index=static_cast<int>(i);break;}
        index=index<0?(reverse?static_cast<int>(stops.size())-1:0):(index+(reverse?-1:1)+static_cast<int>(stops.size()))%static_cast<int>(stops.size());
        renderer.focused=stops[index].hit;SetFocus(stops[index].window);renderer.paint();
        NotifyWinEvent(EVENT_OBJECT_FOCUS,panel,OBJID_CLIENT,CHILDID_SELF);
    }
    bool reducedMotion() const {BOOL animations=TRUE;SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animations,0);return !animations||auditReducedMotion;}
    void scroll(int delta,bool sidebar=false) {
        auto& model=renderer.model;
        if(sidebar||(!model.chatting()&&model.selectedId.empty())) {int count=static_cast<int>(model.cards().size());model.offset=std::clamp(model.offset+(delta<0?1:-1),0,std::max(0,count-chatlayout::visibleRows));}
        else if(model.chatting()){model.assistantFollow=false;model.assistantOffset=std::max(0,model.assistantOffset+(delta<0?48:-48));}
        else if(!model.selectedId.empty()){model.detailFollow=false;model.detailOffset=std::max(0,model.detailOffset+(delta<0?1:-1));}
        renderer.paint();
        log("ui-scroll");
    }
    void moveHome() {
        const POINT origin{0,0}; MONITORINFO info{}; info.cbSize=sizeof(info);
        GetMonitorInfoW(MonitorFromPoint(origin,MONITOR_DEFAULTTOPRIMARY),&info);
        MONITORINFO home=info;
        if(mode==Mode::Pinned)GetMonitorInfoW(MonitorFromWindow(panel,MONITOR_DEFAULTTONEAREST),&info);
        workArea=info.rcWork;
        const auto systemDpi=auditDpi>0?auditDpi:static_cast<float>(GetDpiForWindow(panel));
        renderer.dpi=auditDpi>0?auditDpi:std::min(systemDpi,std::min((workArea.bottom-workArea.top)*96.0f/(HEIGHT+12),(workArea.right-workArea.left)*96.0f/WIDTH));
        const int bottom=home.rcMonitor.bottom;
        const bool bottomTaskbar=home.rcWork.bottom<bottom && home.rcWork.left==home.rcMonitor.left;
        DWORD alignment=1, widgets=0, bytes=sizeof(DWORD);
        const auto registry=L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
        RegGetValueW(HKEY_CURRENT_USER,registry,L"TaskbarAl",RRF_RT_REG_DWORD,nullptr,&alignment,&bytes);
        bytes=sizeof(DWORD); RegGetValueW(HKEY_CURRENT_USER,registry,L"TaskbarDa",RRF_RT_REG_DWORD,nullptr,&widgets,&bytes);
        weatherAvailable=bottomTaskbar && alignment==1 && widgets==1 && bottom-home.rcWork.bottom<=px(96);
        triggerRect={home.rcMonitor.left, bottomTaskbar?home.rcWork.bottom:bottom-px(24),
            home.rcMonitor.left+px(weatherAvailable?144:28), bottom};
        if(!taskbarAdapter)input.configure(triggerRect,weatherAvailable);
        if(trigger && !taskbarAdapter) SetWindowPos(trigger,HWND_TOPMOST,triggerRect.left,triggerRect.top,
            triggerRect.right-triggerRect.left, triggerRect.bottom-triggerRect.top,
            SWP_NOACTIVATE|(weatherAvailable?SWP_SHOWWINDOW:SWP_HIDEWINDOW));
        if(mode!=Mode::Pinned) {
            const int x=workArea.left, y=std::max(workArea.top,workArea.bottom-px(HEIGHT)-px(6));
            SetWindowPos(panel,HWND_TOPMOST,x,y,px(WIDTH),px(HEIGHT),SWP_NOACTIVATE);
        }else {
            RECT bounds{};GetWindowRect(panel,&bounds);const auto x=std::clamp(bounds.left,workArea.left,std::max(workArea.left,workArea.right-px(WIDTH))),y=std::clamp(bounds.top,workArea.top,std::max(workArea.top,workArea.bottom-px(HEIGHT)));
            SetWindowPos(panel,HWND_TOPMOST,x,y,px(WIDTH),px(HEIGHT),SWP_NOACTIVATE);
        }
        renderer.resize(panel);
        if(editor){auto previous=editorFont;
            editorFont=CreateFontW(-px(chatlayout::composerSize),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,ANTIALIASED_QUALITY,DEFAULT_PITCH,chatstyle::font);
            SendMessageW(editor,WM_SETFONT,reinterpret_cast<WPARAM>(editorFont),TRUE);
            SendMessageW(editor,EM_SETMARGINS,EC_LEFTMARGIN|EC_RIGHTMARGIN,MAKELPARAM(px(chatlayout::composerMargin),px(chatlayout::composerMargin)));
            if(previous)DeleteObject(previous);layoutEditors();}
        if(searchEditor){auto previous=searchFont;searchFont=CreateFontW(-px(13),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,ANTIALIASED_QUALITY,DEFAULT_PITCH,chatstyle::font);SendMessageW(searchEditor,WM_SETFONT,reinterpret_cast<WPARAM>(searchFont),TRUE);if(previous)DeleteObject(previous);}
    }
    void raiseWeather() {
        if(taskbarAdapter)return;
        if(!trigger || !IsWindowVisible(trigger))return;
        const POINT center{(triggerRect.left+triggerRect.right)/2,(triggerRect.top+triggerRect.bottom)/2};
        if(WindowFromPoint(center)!=trigger)
            SetWindowPos(trigger,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
    }
    void weatherClick() {
        ++weatherCommands; KillTimer(trigger,TIMER_HOVER); hoverTimer=false;
        if(mode==Mode::Pinned) hide(true); else pin();
        log(taskbarAdapter?"weather-click-redirected":"weather-click-consumed");
    }
    void transition(Mode next) {
        if(next==mode) return;
        // Pinning an already visible peek changes interaction ownership, not
        // the entrance target. Do not replay the entrance or hide its inputs.
        if(next==Mode::Pinned&&mode==Mode::Peek){stopLeave();mode=next;if(finishTimer)finish();else syncComposer();log("transition");return;}
        stopLeave(); KillTimer(panel,TIMER_FINISH); finishTimer=false;
        mode=next;
        if(next!=Mode::Hidden) {
            if(!IsWindowVisible(panel)) { moveHome(); ++reveals; renderer.paint(); }
            motion.retarget(1,clockSeconds());
            if(!reducedMotion())renderer.animate(motion);
            SetWindowPos(panel,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW);
        } else {
            KillTimer(panel,TIMER_CLOCK);
            motion.retarget(0,clockSeconds()); if(!reducedMotion())renderer.animate(motion);
        }
        if(reducedMotion())finish();else finishTimer=SetTimer(panel,TIMER_FINISH,static_cast<UINT>(Motion::duration*1000)+30,nullptr)!=0;
        if(next!=Mode::Hidden)SetTimer(panel,TIMER_CLOCK,60000,nullptr);
        syncComposer();
        log("transition");
    }
    void pin(bool activate=true) {
        transition(Mode::Pinned);
        const auto style=GetWindowLongPtrW(panel,GWL_EXSTYLE);
        SetWindowLongPtrW(panel,GWL_EXSTYLE,style&~WS_EX_NOACTIVATE);
        if(activate&&GetForegroundWindow()!=panel)SetForegroundWindow(panel);
        log("pin");
    }
    void hide(bool suppress=false) {
        if(tooltip)SendMessageW(tooltip,TTM_POP,0,0);tooltipKey.clear();
        cancelPress();if(GetCapture()==panel)ReleaseCapture();renderer.popover.clear();renderer.copyText.clear();renderer.pointerInside=false;renderer.focused=-1;menuReturnFocus=nullptr;
        suppressed=suppress;
        transition(Mode::Hidden);
        SetWindowLongPtrW(panel,GWL_EXSTYLE,GetWindowLongPtrW(panel,GWL_EXSTYLE)|WS_EX_NOACTIVATE);
    }
    void leave() {
        if(mode==Mode::Peek) { leaveTimer=SetTimer(panel,TIMER_LEAVE,190,nullptr)!=0; }
    }
    void finish() {
        KillTimer(panel,TIMER_FINISH); finishTimer=false;
        renderer.settle(mode!=Mode::Hidden);
        if(mode==Mode::Hidden) ShowWindow(panel,SW_HIDE);
        syncComposer();
        log("settled");
    }
    void menu() {
        const HMENU menu=CreatePopupMenu();
        AppendMenuW(menu,MF_STRING,MENU_OPEN,L"Open Hyphen");
        AppendMenuW(menu,MF_STRING,MENU_HIDE,L"Hide Hyphen");
        AppendMenuW(menu,MF_STRING,MENU_LOGS,L"Open diagnostic logs");
        if(testTarget) AppendMenuW(menu,MF_STRING,MENU_TARGET,L"Close test target");
        AppendMenuW(menu,MF_SEPARATOR,0,nullptr);
        AppendMenuW(menu,MF_STRING,MENU_EXIT,L"Exit Hyphen");
        POINT cursor; GetCursorPos(&cursor); SetForegroundWindow(trigger);
        const auto command=TrackPopupMenu(menu,TPM_RETURNCMD|TPM_NONOTIFY|TPM_RIGHTBUTTON,cursor.x,cursor.y,0,trigger,nullptr);
        DestroyMenu(menu);
        if(command==MENU_OPEN) pin(); else if(command==MENU_HIDE) hide();
        else if(command==MENU_LOGS)send("logs");
        else if(command==MENU_EXIT) PostQuitMessage(0);
        else if(command==MENU_TARGET && testTarget) { DestroyWindow(testTarget); testTarget=nullptr; }
        PostMessageW(trigger,WM_NULL,0,0);
    }
    void addTray() {
        tray.cbSize=sizeof(tray); tray.hWnd=trigger; tray.uID=1;
        tray.uFlags=NIF_ICON|NIF_MESSAGE|NIF_TIP; tray.uCallbackMessage=WM_TRAY;
        tray.hIcon=LoadIconW(GetModuleHandleW(nullptr),MAKEINTRESOURCEW(1));
        if(!tray.hIcon) tray.hIcon=LoadIconW(nullptr,IDI_APPLICATION);
        wcscpy_s(tray.szTip,L"Hyphen");
        if(!Shell_NotifyIconW(NIM_ADD,&tray)) throw std::runtime_error("Could not create the native tray icon");
        tray.uVersion=NOTIFYICON_VERSION_4; Shell_NotifyIconW(NIM_SETVERSION,&tray);
    }
};
App* current=nullptr;
LRESULT CALLBACK editProc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(!current||!current->originalEditProc)return DefWindowProcW(window,message,wp,lp);
    auto& app=*current;
    if(message==WM_SETFOCUS&&app.renderer.focused>=0){app.renderer.focused=-1;app.renderer.paint();}
    if(message==WM_SETTEXT) {
        const auto result=CallWindowProcW(app.originalEditProc,window,message,wp,lp);
        // Multiline EDIT does not issue EN_CHANGE for WM_SETTEXT.
        app.editChanged();return result;
    }
    if(message==WM_IME_STARTCOMPOSITION)app.composing=true;
    if(message==WM_IME_ENDCOMPOSITION)app.composing=false;
    if(message==WM_MOUSEACTIVATE||message==WM_LBUTTONDOWN||message==WM_SETFOCUS) {
        app.stopLeave();app.pin(message!=WM_SETFOCUS);
        if(message==WM_MOUSEACTIVATE)return MA_ACTIVATE;
    }
    if(message==WM_MOUSEMOVE)app.stopLeave();
    if(message==WM_GETDLGCODE)return DLGC_WANTALLKEYS|DLGC_WANTCHARS;
    if(message==WM_KEYDOWN&&wp==VK_RETURN&&!app.composing) {
        const bool shift=(GetKeyState(VK_SHIFT)&0x8000)!=0;
        app.suppressEnterChar=!shift;
        if(!shift){if(!(lp&(1LL<<30)))app.reply(app.renderer.model.defaultQueue());return 0;}
    }
    if(message==WM_CHAR&&wp==L'\r'&&app.suppressEnterChar)return 0;
    if(message==WM_KEYUP&&wp==VK_RETURN)app.suppressEnterChar=false;
    if(message==WM_PASTE&&app.pasteImage())return 0;
    if(message==WM_KEYDOWN&&wp=='A'&&(GetKeyState(VK_CONTROL)&0x8000)){SendMessageW(window,EM_SETSEL,0,-1);return 0;}
    if(message==WM_CHAR&&wp==1)return 0;
    if(message==WM_KEYDOWN&&wp=='F'&&(GetKeyState(VK_CONTROL)&0x8000)){app.focusSearch();return 0;}
    if(message==WM_KEYDOWN&&wp==VK_TAB){app.focusNext((GetKeyState(VK_SHIFT)&0x8000)!=0);return 0;}
    if(message==WM_CHAR&&wp==L'\t')return 0;
    if(message==WM_KEYDOWN&&wp==VK_ESCAPE) {
        if(!app.renderer.popover.empty()){app.dismissMenu();return 0;}
        SetFocus(app.panel);app.renderer.model.back();app.syncComposer();app.renderer.paint();return 0;
    }
    const auto result=CallWindowProcW(app.originalEditProc,window,message,wp,lp);
    // Multiline Win32 EDIT does not support EM_SETCUEBANNER. Draw the empty
    // placeholder on this child, where it remains visible with the native caret.
    if(message==WM_PAINT&&GetWindowTextLengthW(window)==0) {
        HDC dc=GetDC(window);if(dc){
            const auto font=SelectObject(dc,app.editorFont);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(102,102,110));
            RECT box{};SendMessageW(window,EM_GETRECT,0,reinterpret_cast<LPARAM>(&box));DrawTextW(dc,L"Message…",-1,&box,DT_LEFT|DT_TOP|DT_SINGLELINE|DT_NOPREFIX);
            SelectObject(dc,font);ReleaseDC(window,dc);
        }
    }
    return result;
}
LRESULT CALLBACK searchProc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(!current||!current->originalSearchProc)return DefWindowProcW(window,message,wp,lp);auto& app=*current;
    if(message==WM_SETFOCUS&&app.renderer.focused>=0){app.renderer.focused=-1;app.renderer.paint();}
    if(message==WM_LBUTTONDOWN)app.pin();
    if(message==WM_SETTEXT){auto result=CallWindowProcW(app.originalSearchProc,window,message,wp,lp);app.searchChanged();return result;}
    if(message==WM_KEYDOWN&&wp=='A'&&(GetKeyState(VK_CONTROL)&0x8000)){SendMessageW(window,EM_SETSEL,0,-1);return 0;}
    if(message==WM_CHAR&&wp==1)return 0;
    if(message==WM_KEYDOWN&&wp=='F'&&(GetKeyState(VK_CONTROL)&0x8000)){app.focusSearch();return 0;}
    if(message==WM_KEYDOWN&&wp==VK_TAB){app.focusNext((GetKeyState(VK_SHIFT)&0x8000)!=0);return 0;}
    if(message==WM_CHAR&&(wp==L'\t'||wp==L'\r'))return 0;
    if(message==WM_KEYDOWN&&wp==VK_RETURN)return 0;
    if(message==WM_KEYDOWN&&wp==VK_ESCAPE){SetWindowTextW(window,L"");SetFocus(app.panel);return 0;}
    const auto result=CallWindowProcW(app.originalSearchProc,window,message,wp,lp);
    if(message==WM_PAINT&&GetWindowTextLengthW(window)==0){HDC dc=GetDC(window);if(dc){auto font=SelectObject(dc,app.searchFont);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(102,102,110));RECT box{};GetClientRect(window,&box);DrawTextW(dc,L"Search chats and tasks",-1,&box,DT_LEFT|DT_TOP|DT_SINGLELINE|DT_NOPREFIX);SelectObject(dc,font);ReleaseDC(window,dc);}}
    return result;
}
void CALLBACK shellChanged(HWINEVENTHOOK,DWORD event,HWND window,LONG,LONG,DWORD,DWORD) {
    if(!current || !current->trigger || current->closing)return;
    if(event==EVENT_SYSTEM_FOREGROUND || window==FindWindowW(L"Shell_TrayWnd",nullptr) || window==GetDesktopWindow())
        PostMessageW(current->trigger,WM_WEATHER_RAISE,0,0);
}
LRESULT CALLBACK panelProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if(!current) return DefWindowProcW(window,message,wp,lp);
    auto& app=*current;
    try {
        switch(message) {
        case WM_GETOBJECT: if(static_cast<DWORD>(lp)==static_cast<DWORD>(OBJID_CLIENT)&&app.accessible&&!app.closing)return LresultFromObject(IID_IAccessible,wp,static_cast<IAccessible*>(app.accessible));break;
        case WM_APP+216:app.accessibleAction(static_cast<long>(wp),false);return 0;
        case WM_APP+217:app.accessibleAction(static_cast<long>(wp),true);return 0;
        case WM_APP+215: {
            if(app.auditCapturePath.empty())return 0;
            Json report={{"dpi",app.renderer.dpi},{"focused",app.renderer.focused},{"connected",app.renderer.model.connected},{"canDraft",app.renderer.model.canDraft()},{"canReply",app.renderer.model.canReply()},{"notice",app.renderer.notice},{"noticeHeight",app.renderer.noticeHeight},{"transcriptBottom",app.renderer.transcriptBottom()},{"reducedMotion",app.reducedMotion()},{"hits",Json::array()}};
            auto& m=app.renderer.model;report["selected"]=m.selectedId;report["detailPending"]=m.detailPending;report["pending"]=m.pending;report["source"]=m.sourceId;report["detailMatchesSelection"]=m.detail.value("id","")==m.selectedId&&m.detail.value("taskKey","")==m.selectedKey;
            report["paintMs"]=app.renderer.paintMs;report["bubbleLayouts"]=app.renderer.bubbleLayouts.size();report["loadingImages"]=app.renderer.loadingImages.size();report["imageBitmaps"]=app.renderer.images.size();report["detailOffset"]=m.detailOffset;report["detailFollow"]=m.detailFollow;report["cachedChats"]=m.recent.size();
            report["composerHeight"]=app.renderer.composerHeight;report["composerLines"]=app.composerLines;report["composerLinePixels"]=app.composerLinePixels;
            RECT editBounds{},format{};GetWindowRect(app.editor,&editBounds);MapWindowPoints(nullptr,app.panel,reinterpret_cast<POINT*>(&editBounds),2);SendMessageW(app.editor,EM_GETRECT,0,reinterpret_cast<LPARAM>(&format));
            report["composerBoundsPx"]={editBounds.left,editBounds.top,editBounds.right,editBounds.bottom};report["composerFormatPx"]={format.left,format.top,format.right,format.bottom};report["composerFocused"]=GetFocus()==app.editor;
            for(const auto& hit:app.renderer.hits)report["hits"].push_back({{"key",Renderer::hitKey(hit)},{"sourceId",hit.card.value("primarySourceId","")},{"action",hit.action},{"enabled",hit.enabled},{"box",{hit.box.left,hit.box.top,hit.box.right,hit.box.bottom}}});
            std::ofstream out(app.auditCapturePath.parent_path()/L"ux-state.json");out<<report.dump(2);return 1;
        }
        case WM_APP+218: {
            if(app.auditCapturePath.empty())return 0;
            // Keyboard state is thread-local and restored immediately. These
            // own-window audit chords exercise the real input procedures.
            BYTE before[256]{},keys[256]{};GetKeyboardState(before);memcpy(keys,before,256);
            if(wp==1)keys[VK_CONTROL]=0x80;else keys[VK_SHIFT]=0x80;
            SetKeyboardState(keys);
            if(wp==1)SendMessageW(app.editor,WM_KEYDOWN,'F',0);
            else if(wp==2)SendMessageW(GetFocus(),WM_KEYDOWN,VK_TAB,0);
            else if(wp==3){SendMessageW(app.editor,WM_KEYDOWN,VK_RETURN,0);SendMessageW(app.editor,WM_CHAR,L'\r',0);SendMessageW(app.editor,WM_KEYUP,VK_RETURN,0);}
            SetKeyboardState(before);return 1;
        }
        case WM_APP+219: {
            if(app.auditCapturePath.empty()||app.draftPath.empty())return 0;
            // HDROP memory is process-local. Construct it in the isolated audit
            // child, then exercise the normal drop handler without the clipboard.
            std::ifstream in(app.draftPath.parent_path()/L"ux-drop.json");Json paths;in>>paths;
            if(!paths.is_array()||paths.size()>5)return 0;std::vector<std::wstring> files;size_t chars=1;
            for(const auto& p:paths){if(!p.is_string()||p.get<std::string>().size()>32768)return 0;files.push_back(wide(p.get<std::string>()));chars+=files.back().size()+1;}
            auto memory=GlobalAlloc(GMEM_MOVEABLE|GMEM_ZEROINIT,sizeof(DROPFILES)+chars*sizeof(wchar_t));if(!memory)return 0;
            auto bytes=static_cast<unsigned char*>(GlobalLock(memory));if(!bytes){GlobalFree(memory);return 0;}
            auto header=reinterpret_cast<DROPFILES*>(bytes);header->pFiles=sizeof(DROPFILES);header->fWide=TRUE;auto text=reinterpret_cast<wchar_t*>(bytes+sizeof(DROPFILES));
            for(const auto& file:files){memcpy(text,file.c_str(),(file.size()+1)*sizeof(wchar_t));text+=file.size()+1;}GlobalUnlock(memory);
            SendMessageW(window,WM_DROPFILES,reinterpret_cast<WPARAM>(memory),0);return 1;
        }
        case WM_APP+210: if(!app.auditCapturePath.empty())app.renderer.paint(app.auditCapturePath);return 0;
        case WM_APP+211:
            if(!app.auditCapturePath.empty()&&wp<std::size(auditActionNames))for(const auto& hit:app.renderer.hits)if(hit.enabled&&hit.action==auditActionNames[wp])return MAKELRESULT(static_cast<WORD>((hit.box.left+hit.box.right)/2),static_cast<WORD>((hit.box.top+hit.box.bottom)/2));
            return 0;
        case WM_APP+212:
            if(!app.auditCapturePath.empty()&&wp<app.renderer.messageTargets.size()){auto box=app.renderer.messageTargets[wp].box;return MAKELRESULT(static_cast<WORD>((box.left+box.right)/2),static_cast<WORD>((box.top+box.bottom)/2));}return 0;
        case WM_APP+213: return app.auditCapturePath.empty()?0:app.renderer.draws;
        case WM_APP+214: {
            if(app.auditCapturePath.empty())return 0;unsigned tails=0;for(const auto& target:app.renderer.messageTargets)if(target.card.value("tail",false))++tails;
            return MAKELONG(app.renderer.messageTargets.size(),tails);
        }
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: { PAINTSTRUCT paint; BeginPaint(window,&paint); EndPaint(window,&paint); return 0; }
        case WM_MOUSEMOVE:
            app.stopLeave();
            app.pointerMove(GET_X_LPARAM(lp)*96/app.renderer.dpi,GET_Y_LPARAM(lp)*96/app.renderer.dpi);
            if(!app.trackedPanel) { TRACKMOUSEEVENT t{sizeof(t),TME_LEAVE,window,0}; TrackMouseEvent(&t); app.trackedPanel=true; }
            return 0;
        case WM_MOUSELEAVE: app.trackedPanel=false;app.pointerMove(-1,-1,false); app.leave(); return 0;
        case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
        case WM_SETCURSOR: if(LOWORD(lp)==HTCLIENT){POINT point{};GetCursorPos(&point);ScreenToClient(window,&point);if(app.composerAt(point.x*96/app.renderer.dpi,point.y*96/app.renderer.dpi)){SetCursor(LoadCursorW(nullptr,IDC_IBEAM));return TRUE;}}break;
        case WM_LBUTTONDOWN:app.pointerDown(GET_X_LPARAM(lp)*96/app.renderer.dpi,GET_Y_LPARAM(lp)*96/app.renderer.dpi);return 0;
        case WM_LBUTTONUP:app.pointerUp(GET_X_LPARAM(lp)*96/app.renderer.dpi,GET_Y_LPARAM(lp)*96/app.renderer.dpi);return 0;
        case WM_CANCELMODE:app.cancelPress();if(GetCapture()==window)ReleaseCapture();return 0;
        case WM_CAPTURECHANGED:app.cancelPress();return 0;
        case WM_CONTEXTMENU: {POINT point{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};if(point.x==-1&&point.y==-1)return 0;ScreenToClient(window,&point);app.contextMenu(point.x*96/app.renderer.dpi,point.y*96/app.renderer.dpi);return 0;}
        case WM_MOUSEWHEEL: {POINT point{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};ScreenToClient(window,&point);app.scroll(GET_WHEEL_DELTA_WPARAM(wp),point.x<app.px(SIDEBAR_RIGHT));return 0;}
        case WM_DROPFILES: {auto drop=reinterpret_cast<HDROP>(wp);Json paths=Json::array();UINT count=DragQueryFileW(drop,0xffffffff,nullptr,0);
            for(UINT i=0;i<std::min(count,5U);++i){wchar_t file[32768]{};DragQueryFileW(drop,i,file,32768);paths.push_back(utf8(file));}DragFinish(drop);app.attach(paths);return 0;}
        case WM_NCHITTEST: {
            POINT p{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)}; ScreenToClient(window,&p);
            for(const auto& hit:app.renderer.hits)if(p.x>=app.px(hit.box.left)&&p.x<=app.px(hit.box.right)&&p.y>=app.px(hit.box.top)&&p.y<=app.px(hit.box.bottom))return HTCLIENT;
            if(p.y>=app.px(24) && p.y<app.px(74) && p.x<app.px(WIDTH-72)) return HTCAPTION;
            return HTCLIENT;
        }
        case WM_NCMOUSEMOVE: {
            app.pointerMove(-1,-1,false);app.stopLeave(); TRACKMOUSEEVENT t{sizeof(t),TME_LEAVE|TME_NONCLIENT,window,0}; TrackMouseEvent(&t); return 0;
        }
        case WM_NCMOUSELEAVE: app.leave(); return 0;
        case WM_NCLBUTTONDOWN: if(wp==HTCAPTION) app.pin(); break;
        case WM_ENTERSIZEMOVE: app.pin(); break;
        case WM_EXITSIZEMOVE: app.log("dragged"); break;
        case WM_KEYDOWN:
            if(wp==VK_TAB){app.focusNext((GetKeyState(VK_SHIFT)&0x8000)!=0);return 0;}
            if(wp=='F'&&(GetKeyState(VK_CONTROL)&0x8000)){app.focusSearch();return 0;}
            if((wp==VK_RETURN||wp==VK_SPACE)&&!(lp&(1LL<<30))&&app.renderer.focused>=0&&app.renderer.focused<static_cast<int>(app.renderer.hits.size())){auto box=app.renderer.hits[app.renderer.focused].box;app.click((box.left+box.right)/2,(box.top+box.bottom)/2);return 0;}
            if(wp==VK_ESCAPE) {if(!app.renderer.popover.empty())app.dismissMenu();else if(!app.renderer.model.selectedId.empty()){app.renderer.model.back();app.syncComposer();app.renderer.paint();}else app.hide();return 0;}
            if((wp==VK_UP||wp==VK_DOWN)&&!app.renderer.popover.empty()){app.focusNext(wp==VK_UP);return 0;}
            if(wp==VK_RETURN&&!app.renderer.popover.empty())return 0;
            if(wp==VK_UP||wp==VK_DOWN){app.scroll(wp==VK_UP?1:-1);return 0;}
            if(wp=='V'&&(GetKeyState(VK_CONTROL)&0x8000)&&app.pasteImage())return 0;
            if(wp==VK_RETURN||wp==VK_SPACE)return 0;
            break;
        case WM_COMMAND:
            if(LOWORD(wp)==REPLY_EDIT&&HIWORD(wp)==EN_CHANGE){app.editChanged();return 0;}
            if(LOWORD(wp)==SEARCH_EDIT&&HIWORD(wp)==EN_CHANGE){app.searchChanged();return 0;}
            break;
        case WM_CTLCOLOREDIT:
        case WM_CTLCOLORSTATIC:
            if(reinterpret_cast<HWND>(lp)==app.editor) {
                SetTextColor(reinterpret_cast<HDC>(wp),chatstyle::editorText);
                SetBkColor(reinterpret_cast<HDC>(wp),chatstyle::editorBackground);
                return reinterpret_cast<LRESULT>(app.editorBrush);
            }
            if(reinterpret_cast<HWND>(lp)==app.searchEditor){SetTextColor(reinterpret_cast<HDC>(wp),chatstyle::editorText);SetBkColor(reinterpret_cast<HDC>(wp),chatstyle::searchBackground);return reinterpret_cast<LRESULT>(app.searchBrush);}
            break;
        case WM_TIMER:
            if(wp==TIMER_DETAILS){KillTimer(window,TIMER_DETAILS);if(app.renderer.model.detailPending&&app.mode!=Mode::Hidden)app.renderer.paint();return 0;}
            if(wp==TIMER_DRAFT){KillTimer(window,TIMER_DRAFT);app.saveDrafts();return 0;}
            if(wp==TIMER_CLOCK){if(app.mode!=Mode::Hidden&&app.renderer.model.selectedId.empty())app.renderer.paint();SetTimer(window,TIMER_CLOCK,60000,nullptr);return 0;}
            if(wp==TIMER_AUDIT_EXIT) {KillTimer(window,TIMER_AUDIT_EXIT); PostQuitMessage(0); return 0;}
            if(wp==TIMER_FINISH) {app.finish(); return 0;}
            if(wp==TIMER_LEAVE) {
                app.stopLeave(); POINT p; GetCursorPos(&p); RECT r; GetWindowRect(window,&r);
                const bool outsideTrigger=app.taskbarAdapter?!app.weatherInside:!PtInRect(&app.triggerRect,p);
                if(!PtInRect(&r,p) && outsideTrigger && app.mode==Mode::Peek) app.hide();
                return 0;
            } break;
        case WM_CLOSE: app.hide(); return 0;
        case WM_DPICHANGED: {if(app.mode==Mode::Pinned&&lp){const auto box=*reinterpret_cast<RECT*>(lp);SetWindowPos(window,nullptr,box.left,box.top,box.right-box.left,box.bottom-box.top,SWP_NOZORDER|SWP_NOACTIVATE);}app.moveHome();app.syncComposer();if(app.mode!=Mode::Hidden)app.renderer.paint();app.log("dpi-change");return 0;}
        case WM_DISPLAYCHANGE: app.moveHome(); app.log("display-change"); return 0;
        case WM_SETTINGCHANGE: app.moveHome();if(app.finishTimer&&app.reducedMotion())app.finish();app.syncComposer();if(app.mode!=Mode::Hidden)app.renderer.paint(); app.log("settings-change"); return 0;
        }
    } catch(const std::exception& error) {
        app.error(error);
        MessageBoxA(window,error.what(),"Hyphen",MB_OK|MB_ICONERROR); PostQuitMessage(1); return 0;
    }
    return DefWindowProcW(window,message,wp,lp);
}
LRESULT CALLBACK triggerProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if(!current) return DefWindowProcW(window,message,wp,lp);
    auto& app=*current;
    try {
        if(message==taskbar::message) {
            if(!app.taskbarAdapter || !taskbar::accepted(app.adapterEndpoint,wp))return 0;
            switch(static_cast<taskbar::Command>(lp)) {
            case taskbar::Command::Hello: return 1;
            case taskbar::Command::Ready: app.adapterReady=true; app.log("adapter-ready"); return 1;
            case taskbar::Command::Hover:
                app.weatherInside=true; app.stopLeave();
                if(!app.suppressed && app.mode==Mode::Hidden)app.transition(Mode::Peek);
                app.log("weather-hover-redirected"); return 1;
            case taskbar::Command::Leave:
                app.weatherInside=false; app.suppressed=false; app.leave(); app.log("weather-leave-observed"); return 1;
            case taskbar::Command::Click: app.weatherInside=true; app.weatherClick(); return 1;
            case taskbar::Command::Stopped: case taskbar::Command::Failed:
                app.adapterReady=false; app.log(lp==static_cast<LPARAM>(taskbar::Command::Failed)?"adapter-failed":"adapter-stopped");
                if(lp==static_cast<LPARAM>(taskbar::Command::Stopped)||!app.bridge.connected)PostQuitMessage(0);
                else app.renderer.model.message="Weather shortcut unavailable. Open the queue from its tray icon.";
                return 1;
            }
            return 0;
        }
        if(message==app.taskbarCreated && app.taskbarCreated) {
            if(!app.allowAdapterAttach)return 0;
            app.addTray(); app.moveHome();
            if(app.taskbarAdapter&&app.allowAdapterAttach) {app.adapterReady=false; app.attachAdapter(); app.log("explorer-restarted");}
            return 0;
        }
        switch(message) {
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: {
            PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); RECT bounds; GetClientRect(window,&bounds);
            FillRect(dc,&bounds,reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
            EndPaint(window,&paint); return 0;
        }
        case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
        case WM_MOUSEMOVE: app.stopLeave(); return 0;
        case WM_WEATHER_ENTER:
            app.weatherInside=true; app.stopLeave(); app.raiseWeather();
            if(!app.suppressed && app.mode==Mode::Hidden)
                app.hoverTimer=SetTimer(window,TIMER_HOVER,140,nullptr)!=0;
            app.log("weather-enter"); return 0;
        case WM_WEATHER_LEAVE:
            app.weatherInside=false; app.suppressed=false;
            KillTimer(window,TIMER_HOVER); app.hoverTimer=false; app.leave(); app.log("weather-leave"); return 0;
        case WM_WEATHER_RAISE: app.raiseWeather(); return 0;
        case WM_WEATHER_CLICK: app.weatherClick(); return 0;
        case WM_WEATHER_MENU: app.menu(); return 0;
        case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_RBUTTONDOWN: case WM_RBUTTONUP: return 0;
        case WM_TIMER:
            if(wp==TIMER_HOVER) {
                KillTimer(window,TIMER_HOVER); app.hoverTimer=false;
                if(app.weatherInside && !app.suppressed && app.mode==Mode::Hidden) app.transition(Mode::Peek);
                return 0;
            } break;
        case WM_TRAY:
            if(LOWORD(lp)==WM_CONTEXTMENU) app.menu();
            else if(LOWORD(lp)==NIN_SELECT || LOWORD(lp)==NIN_KEYSELECT) app.pin(); return 0;
        case WM_CLOSE: PostQuitMessage(0); return 0;
        }
    } catch(const std::exception& error) {
        app.error(error);
        MessageBoxA(window,error.what(),"Hyphen",MB_OK|MB_ICONERROR); PostQuitMessage(1); return 0;
    }
    return DefWindowProcW(window,message,wp,lp);
}
LRESULT CALLBACK targetProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if(message==WM_PAINT) {
        PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); RECT r; GetClientRect(window,&r);
        FillRect(dc,&r,reinterpret_cast<HBRUSH>(COLOR_WINDOW+1));
        DrawTextW(dc,L"Move here\nto dismiss",-1,&r,DT_CENTER|DT_VCENTER|DT_WORDBREAK);
        EndPaint(window,&paint); return 0;
    }
    if(message==WM_CLOSE) { if(current) current->testTarget=nullptr; DestroyWindow(window); return 0; }
    return DefWindowProcW(window,message,wp,lp);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const bool isolated=wcsstr(GetCommandLineW(),L"--isolated-session")!=nullptr;
    const std::wstring mutexName=L"Local\\WorkUpdatesNativeHoverPreview-v1"+(isolated?L"-test-"+std::to_wstring(GetCurrentProcessId()):L"");
    HANDLE mutex=CreateMutexW(nullptr,FALSE,mutexName.c_str());
    if(!mutex || GetLastError()==ERROR_ALREADY_EXISTS) {if(mutex) CloseHandle(mutex); return 0;}
    CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    App app; current=&app;app.renderer.model.view=4;
    wchar_t executable[MAX_PATH]; GetModuleFileNameW(nullptr,executable,MAX_PATH);
    const auto directory=std::filesystem::path(executable).parent_path()/L"artifacts";
    std::filesystem::create_directories(directory); app.tracePath=directory/L"native-hover.jsonl";
    if(std::filesystem::exists(app.tracePath)&&std::filesystem::file_size(app.tracePath)>512*1024){auto backup=app.tracePath;backup+=L".1";std::error_code ec;std::filesystem::remove(backup,ec);std::filesystem::rename(app.tracePath,backup,ec);}
    int count; LPWSTR* args=CommandLineToArgvW(GetCommandLineW(),&count); bool test=false, show=false, standalone=false;
    std::filesystem::path descriptor=deployment::installation(std::filesystem::path(executable).parent_path())/L"data/desktop/native-control.info";
    bool explicitBridge=false,autoAttach=true,uiAudit=false; unsigned auditExitMs=0;
    for(int i=1;i<count;++i) {
        test|=wcscmp(args[i],L"--test-target")==0; show|=wcscmp(args[i],L"--show")==0;
        standalone|=wcscmp(args[i],L"--standalone")==0;
        app.taskbarAdapter|=wcscmp(args[i],L"--taskbar-adapter")==0;
        if(wcscmp(args[i],L"--legacy-trigger")==0)app.taskbarAdapter=false;
        if(wcscmp(args[i],L"--no-auto-attach")==0)autoAttach=false;
        if(wcscmp(args[i],L"--ui-audit")==0)uiAudit=true;
        if(wcscmp(args[i],L"--assistant")==0)app.renderer.model.view=4;
        if(wcscmp(args[i],L"--capture")==0&&i+1<count)app.capturePath=args[++i];
        if(wcscmp(args[i],L"--audit-capture")==0&&i+1<count)app.auditCapturePath=args[++i];
        if(wcscmp(args[i],L"--audit-dpi")==0&&i+1<count)app.auditDpi=std::clamp(static_cast<float>(wcstoul(args[++i],nullptr,10)),96.0f,192.0f);
        if(wcscmp(args[i],L"--audit-reduced-motion")==0)app.auditReducedMotion=true;
        if(wcscmp(args[i],L"--audit-thumbnail-delay-ms")==0&&i+1<count)app.renderer.thumbnails.auditDelayMs=std::min(3000UL,wcstoul(args[++i],nullptr,10));
        if(wcscmp(args[i],L"--bridge")==0 && i+1<count) {descriptor=args[++i]; explicitBridge=true;}
        if(wcscmp(args[i],L"--audit-exit-ms")==0 && i+1<count) auditExitMs=std::min(10000UL,wcstoul(args[++i],nullptr,10));
    }
    LocalFree(args);
    // Every entry point, including Explorer's TaskbarCreated broadcast, must
    // honor test isolation and the explicit no-auto-attach option.
    app.allowAdapterAttach=autoAttach&&!standalone&&!isolated;
    if(app.auditCapturePath.empty()){app.auditDpi=0;app.auditReducedMotion=false;app.renderer.thumbnails.auditDelayMs=0;}
    if(!standalone){
        app.draftPath=descriptor.parent_path()/L"drafts.json";
        try{std::ifstream saved(app.draftPath,std::ios::binary);if(saved){Json data;saved>>data;auto drafts=data.contains("drafts")?data["drafts"]:data;
            if(drafts.is_object())for(auto it=drafts.begin();it!=drafts.end();++it)if(it.value().is_string()&&it.key().size()<512&&it.value().get<std::string>().size()<=48000)app.renderer.model.drafts[it.key()]=it.value().get<std::string>();
            auto images=data.value("attachments",Json::object());if(images.is_object())for(auto it=images.begin();it!=images.end();++it)if(it.key().size()<512&&it.value().is_array()&&it.value().size()<=4){Json clean=Json::array();for(const auto& image:it.value())if(image.is_object()&&image.contains("id")&&image["id"].is_string()&&image.value("path","").size()<32768)clean.push_back(image);app.renderer.model.attachments[it.key()]=clean;}
            auto ids=data.value("intentIds",Json::object());if(ids.is_object())for(auto it=ids.begin();it!=ids.end();++it)if(it.value().is_string()&&it.value().get<std::string>().size()==36&&(app.renderer.model.drafts.contains(it.key())||app.renderer.model.attachments.contains(it.key())))app.renderer.model.intentIds[it.key()]=it.value().get<std::string>();}}
        catch(...){app.log("draft-storage-read-failed");app.draftPath.clear();}
    }
    int exitCode=0;
    try {
        if(!standalone && (explicitBridge || std::filesystem::exists(descriptor))) app.bridge.claim(descriptor);
        WNDCLASSEXW wc{}; wc.cbSize=sizeof(wc); wc.hInstance=instance; wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);
        wc.hIcon=LoadIconW(instance,MAKEINTRESOURCEW(1)); wc.lpszClassName=L"NativeHoverPanel"; wc.lpfnWndProc=panelProc;
        if(!RegisterClassExW(&wc)) throw std::runtime_error("Panel class registration failed");
        wc.lpszClassName=L"NativeHoverTrigger"; wc.lpfnWndProc=triggerProc;
        if(!RegisterClassExW(&wc)) throw std::runtime_error("Trigger class registration failed");
        app.panel=CreateWindowExW(WS_EX_TOPMOST|(uiAudit?WS_EX_APPWINDOW:WS_EX_TOOLWINDOW)|WS_EX_NOACTIVATE|WS_EX_NOREDIRECTIONBITMAP,
            L"NativeHoverPanel",L"Hyphen",WS_POPUP,0,0,static_cast<int>(WIDTH),static_cast<int>(HEIGHT),
            nullptr,nullptr,instance,nullptr);
        if(!app.panel) throw std::runtime_error("Panel creation failed");
        app.renderer.dpi=static_cast<float>(GetDpiForWindow(app.panel)); app.moveHome();
        app.renderer.init(app.panel);
        app.renderer.thumbnails.start();
        app.initComposer();
        DragAcceptFiles(app.panel,TRUE);
        if(app.bridge.connected)app.queueClient.start(descriptor);
        app.trigger=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|(app.taskbarAdapter?0:WS_EX_TOPMOST|WS_EX_LAYERED),
            L"NativeHoverTrigger",L"Native Hover Trigger",WS_POPUP,0,0,28,48,nullptr,nullptr,instance,nullptr);
        if(!app.trigger) throw std::runtime_error("Trigger creation failed");
        app.moveHome();
        if(app.taskbarAdapter) {
            // A hidden control window receives commands; it never covers the taskbar.
            app.adapterEndpoint=taskbar::publish(app.trigger,executable);
        } else {
        SetLayeredWindowAttributes(app.trigger,0,1,LWA_ALPHA);
        // Shell launches may request SW_HIDE. Explicit visibility is required
        // for this invisible input surface; first-call ShowWindow can honor that startup override.
        SetWindowPos(app.trigger,HWND_TOPMOST,0,0,0,0,
            SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|(app.weatherAvailable?SWP_SHOWWINDOW:SWP_HIDEWINDOW));
        if(!app.input.start(app.trigger)) throw std::runtime_error("Could not install the weather input guard");
        app.foregroundHook=SetWinEventHook(EVENT_SYSTEM_FOREGROUND,EVENT_SYSTEM_FOREGROUND,nullptr,shellChanged,0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        app.reorderHook=SetWinEventHook(EVENT_OBJECT_REORDER,EVENT_OBJECT_REORDER,nullptr,shellChanged,0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        }
        app.taskbarCreated=RegisterWindowMessageW(L"TaskbarCreated"); app.addTray();
        if(test) {
            wc.lpszClassName=L"NativeHoverTestTarget"; wc.lpfnWndProc=targetProc; wc.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
            RegisterClassExW(&wc);
            app.testTarget=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TOPMOST,L"NativeHoverTestTarget",
                L"Native hover test target",WS_POPUP|WS_BORDER,app.workArea.left+app.px(WIDTH)+40,
                app.workArea.bottom-app.px(160),140,100,nullptr,nullptr,instance,nullptr);
            SetWindowPos(app.testTarget,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW);
        }
        app.log("started"); if(show) app.pin();
        if(app.taskbarAdapter && !standalone && autoAttach)app.attachAdapter();
        if(auditExitMs) SetTimer(app.panel,TIMER_AUDIT_EXIT,auditExitMs,nullptr);
        bool running=true;
        while(running) {
            HANDLE waiters[4]{}; DWORD waitCount=0,bridgeIndex=MAXDWORD,controlIndex=MAXDWORD,queueIndex=MAXDWORD,thumbnailIndex=MAXDWORD;
            if(app.renderer.thumbnails.event){thumbnailIndex=waitCount;waiters[waitCount++]=app.renderer.thumbnails.event;}
            if(app.queueClient.event){queueIndex=waitCount;waiters[waitCount++]=app.queueClient.event;}
            if(app.bridge.connected) {bridgeIndex=waitCount; waiters[waitCount++]=app.bridge.event;}
            if(app.adapterControl) {controlIndex=waitCount; waiters[waitCount++]=app.adapterControl;}
            const DWORD result=MsgWaitForMultipleObjectsEx(waitCount,waiters,INFINITE,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
            if(queueIndex!=MAXDWORD && result==WAIT_OBJECT_0+queueIndex)app.queueEvents();
            if(thumbnailIndex!=MAXDWORD&&result==WAIT_OBJECT_0+thumbnailIndex){app.renderer.thumbnailEvents();if(app.mode!=Mode::Hidden)app.renderer.paint();}
            if(bridgeIndex!=MAXDWORD && result==WAIT_OBJECT_0+bridgeIndex) {
                app.log("bridge-lost"); break; // Old app can own the corner again; never fight it.
            }
            if(controlIndex!=MAXDWORD && result==WAIT_OBJECT_0+controlIndex) {
                DWORD code=1; GetExitCodeProcess(app.adapterControl,&code); CloseHandle(app.adapterControl); app.adapterControl=nullptr;
                if(code) {app.log("adapter-attach-failed");
                    if(!app.bridge.connected){exitCode=1;break;}
                    app.renderer.model.message="Weather shortcut unavailable. Use the tray icon.";
                }
                app.log("adapter-controller-finished");
            }
            if(result==WAIT_FAILED) {app.log("message-wait-failed"); exitCode=1; break;}
            MSG message{};
            while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
                if(message.message==WM_QUIT) {exitCode=static_cast<int>(message.wParam); app.log(exitCode?"quit-error":"quit-success"); running=false; break;}
                TranslateMessage(&message); DispatchMessageW(&message);
            }
        }
    } catch(const std::exception& error) {app.error(error); MessageBoxA(nullptr,error.what(),"Hyphen",MB_OK|MB_ICONERROR); exitCode=1;}
    app.saveDrafts();app.closing=true; app.log("stopped");
    if(app.accessible){app.accessible->detach();app.accessible->Release();app.accessible=nullptr;}
    if(app.accessibleProps.get()){const MSAAPROPID names[]{PROPID_ACC_NAME};if(app.editor)app.accessibleProps->ClearHwndProps(app.editor,OBJID_CLIENT,CHILDID_SELF,names,1);if(app.searchEditor)app.accessibleProps->ClearHwndProps(app.searchEditor,OBJID_CLIENT,CHILDID_SELF,names,1);}
    if(app.tooltip)DestroyWindow(app.tooltip);
    if(app.adapterControl)CloseHandle(app.adapterControl);
    if(app.taskbarAdapter && app.adapterEndpoint.cookie) {
        taskbar::Endpoint published;
        if(taskbar::readEndpoint(taskbar::endpointPath(executable),published) && published.cookie==app.adapterEndpoint.cookie)
            std::filesystem::remove(taskbar::endpointPath(executable));
    }
    app.input.stop();
    if(app.foregroundHook)UnhookWinEvent(app.foregroundHook); if(app.reorderHook)UnhookWinEvent(app.reorderHook);
    Shell_NotifyIconW(NIM_DELETE,&app.tray);
    if(app.trigger) DestroyWindow(app.trigger); if(app.testTarget) DestroyWindow(app.testTarget); if(app.panel) DestroyWindow(app.panel);
    if(app.editorFont)DeleteObject(app.editorFont);if(app.editorBrush)DeleteObject(app.editorBrush);
    if(app.searchFont)DeleteObject(app.searchFont);if(app.searchBrush)DeleteObject(app.searchBrush);
    app.queueClient.close();
    app.bridge.close();
    app.log(exitCode?"exiting-error":"exiting-success");
    current=nullptr; CoUninitialize(); CloseHandle(mutex); return exitCode;
}
