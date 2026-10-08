#pragma once
#include <windows.h>
#include <inspectable.h>
#include <roapi.h>
#include <winstring.h>
#include <mutex>
#include <cmath>
#include <iterator>

// ABI from Microsoft's Windows.UI.ViewManagement IUISettings2 metadata.
// This keeps the Win32 shell independent of a C++/WinRT projection/runtime.
namespace textscale {
inline constexpr GUID settingsId{0xbad82401,0x2721,0x44f9,{0xbb,0x91,0x2b,0xb2,0x28,0xbe,0x44,0x2f}};
inline constexpr GUID handlerId{0x2dbdba9d,0x20da,0x519d,{0x90,0x78,0x09,0xf8,0x35,0xbc,0x5b,0xc7}};
inline constexpr GUID agileId{0x94ea2b94,0xe9cc,0x49e0,{0xc0,0xff,0xee,0x64,0xca,0x8f,0x5b,0x90}};
struct Token {INT64 value=0;};
struct ChangeHandler: IUnknown {virtual HRESULT STDMETHODCALLTYPE Invoke(IInspectable*,IInspectable*)=0;};
struct Settings: IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_TextScaleFactor(DOUBLE*)=0;
    virtual HRESULT STDMETHODCALLTYPE add_TextScaleFactorChanged(ChangeHandler*,Token*)=0;
    virtual HRESULT STDMETHODCALLTYPE remove_TextScaleFactorChanged(Token)=0;
};
class Handler final: public ChangeHandler {
    LONG references=1;std::mutex guard;HWND window;UINT message;
public:
    Handler(HWND target,UINT notification):window(target),message(notification){}
    void detach(){std::lock_guard lock(guard);window=nullptr;}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void** result) override {
        if(!result)return E_POINTER;*result=nullptr;
        if(id==__uuidof(IUnknown)||id==handlerId||id==agileId){*result=static_cast<ChangeHandler*>(this);AddRef();return S_OK;}return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override{return InterlockedIncrement(&references);}
    ULONG STDMETHODCALLTYPE Release() override{const auto left=InterlockedDecrement(&references);if(!left)delete this;return left;}
    HRESULT STDMETHODCALLTYPE Invoke(IInspectable*,IInspectable*) override {
        // The system may call from another thread. Only the owned UI thread
        // reads settings or touches layout/native controls.
        std::lock_guard lock(guard);if(window)PostMessageW(window,message,0,0);return S_OK;
    }
};
class Monitor {
    Settings* settings=nullptr;Handler* handler=nullptr;Token token{};bool subscribed=false;
public:
    Monitor()=default;Monitor(const Monitor&)=delete;Monitor& operator=(const Monitor&)=delete;
    ~Monitor(){reset();}
    bool start(HWND target,UINT message){
        reset();constexpr wchar_t name[]=L"Windows.UI.ViewManagement.UISettings";HSTRING className=nullptr;
        if(FAILED(WindowsCreateString(name,static_cast<UINT32>(std::size(name)-1),&className)))return false;
        IInspectable* instance=nullptr;const auto activated=RoActivateInstance(className,&instance);WindowsDeleteString(className);
        if(FAILED(activated)||!instance){if(instance)instance->Release();return false;}
        const auto queried=instance->QueryInterface(settingsId,reinterpret_cast<void**>(&settings));instance->Release();
        if(FAILED(queried)||!settings){settings=nullptr;return false;}
        handler=new Handler(target,message);subscribed=SUCCEEDED(settings->add_TextScaleFactorChanged(handler,&token));return available();
    }
    bool available()const{return settings!=nullptr;}
    bool watching()const{return subscribed;}
    bool read(float& scale)const{
        DOUBLE value=1;if(!settings||FAILED(settings->get_TextScaleFactor(&value))||!std::isfinite(value)||value<1||value>2.25)return false;
        scale=static_cast<float>(value);return true;
    }
    void reset(){
        if(handler)handler->detach();
        if(settings&&subscribed)settings->remove_TextScaleFactorChanged(token);
        subscribed=false;if(handler){handler->Release();handler=nullptr;}if(settings){settings->Release();settings=nullptr;}
    }
};
}
