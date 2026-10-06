#pragma once
#include <windows.h>
#include <thread>
#include <mutex>
#include "input-policy.h"

constexpr UINT WM_WEATHER_ENTER=WM_APP+10, WM_WEATHER_LEAVE=WM_APP+11,
    WM_WEATHER_CLICK=WM_APP+12, WM_WEATHER_RAISE=WM_APP+13, WM_WEATHER_MENU=WM_APP+14;

// The hook lives on a dedicated message thread. It never draws, logs, reads
// files, or waits on the UI thread. Only tile-owned button pairs are consumed.
struct InputGuard {
    inline static InputGuard* active=nullptr;
    HWND target=nullptr;
    HHOOK hook=nullptr;
    DWORD threadId=0;
    HANDLE ready=nullptr;
    std::thread worker;
    std::mutex boundsMutex;
    RECT bounds{};
    bool enabled=false;
    WeatherInputPolicy policy;
    ~InputGuard(){stop();}
    void configure(RECT next, bool available) {
        std::lock_guard<std::mutex> lock(boundsMutex); bounds=next; enabled=available;
    }
    static LRESULT CALLBACK mouse(int code, WPARAM message, LPARAM location) {
        auto* guard=active;
        if(code<0 || !guard) return CallNextHookEx(nullptr,code,message,location);
        const auto* event=reinterpret_cast<const MSLLHOOKSTRUCT*>(location);
        bool inTile;
        {
            std::lock_guard<std::mutex> lock(guard->boundsMutex);
            inTile=guard->enabled && PtInRect(&guard->bounds,event->pt);
        }
        if(inTile!=guard->policy.inside) {
            guard->policy.inside=inTile;
            PostMessageW(guard->target,inTile?WM_WEATHER_ENTER:WM_WEATHER_LEAVE,0,0);
        }
        if(inTile && WindowFromPoint(event->pt)!=guard->target)
            PostMessageW(guard->target,WM_WEATHER_RAISE,0,0);
        bool activate=false, consume=false;
        switch(message) {
        case WM_LBUTTONDOWN: consume=guard->policy.down(inTile); break;
        case WM_LBUTTONUP:
            consume=guard->policy.up(inTile,activate);
            if(activate) PostMessageW(guard->target,WM_WEATHER_CLICK,0,0); break;
        case WM_RBUTTONDOWN: consume=guard->policy.down(inTile,true); break;
        case WM_RBUTTONUP:
            consume=guard->policy.up(inTile,activate,true);
            if(activate) PostMessageW(guard->target,WM_WEATHER_MENU,0,0); break;
        }
        if(consume) return 1; // Never pass this button event to Widgets or another listener.
        return CallNextHookEx(nullptr,code,message,location);
    }
    bool start(HWND window) {
        target=window; ready=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        if(!ready)return false;
        worker=std::thread([this]{
            threadId=GetCurrentThreadId(); MSG message{};
            PeekMessageW(&message,nullptr,WM_USER,WM_USER,PM_NOREMOVE);
            active=this;
            hook=SetWindowsHookExW(WH_MOUSE_LL,mouse,GetModuleHandleW(nullptr),0);
            SetEvent(ready);
            if(hook) {
                while(GetMessageW(&message,nullptr,0,0)>0) {TranslateMessage(&message);DispatchMessageW(&message);}
                UnhookWindowsHookEx(hook); hook=nullptr;
            }
            active=nullptr;
        });
        WaitForSingleObject(ready,INFINITE); return hook!=nullptr;
    }
    void stop() {
        if(worker.joinable()) {PostThreadMessageW(threadId,WM_QUIT,0,0);worker.join();}
        if(ready){CloseHandle(ready);ready=nullptr;}
    }
};
