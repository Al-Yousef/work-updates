#include <iostream>
#include <vector>
#include <stdexcept>
#include <thread>
#include "../taskbar-adapter/adapter.cpp"
#include "../src/text-scale.h"

namespace test {
unsigned hoverCalls=0,taskbarClicks=0,launchClicks=0,leaveCalls=0,checks=0;
unsigned textNotifications=0;DWORD notificationThread=0;
std::atomic<bool> stallHello{false};std::atomic<HWND> healthWindow{nullptr};std::atomic<ULONG_PTR> healthCookie{0};
std::vector<taskbar::Command> received;
void check(bool result,const char* name) {++checks; if(!result)throw std::runtime_error(name);}
__declspec(noinline) void WINAPI hover(void* object) {hoverCalls+=object?1:2; MemoryBarrier();}
__declspec(noinline) void WINAPI click(void* object,IInspectable* const& sender,IInspectable* const& args) {
    taskbarClicks+=object && sender && !args?1:2; MemoryBarrier();
}
__declspec(noinline) void WINAPI launch(void* object,IInspectable* const& sender,IInspectable* const& args) {
    launchClicks+=object && sender && !args?1:2; MemoryBarrier();
}
__declspec(noinline) void WINAPI leave(void* object,IInspectable* const&) {leaveCalls+=object?1:2; MemoryBarrier();}
struct Sender final:IInspectable {
    std::wstring name; bool fail=false;
    explicit Sender(const wchar_t* value):name(value){}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID,void** out) override {*out=nullptr; return E_NOINTERFACE;}
    ULONG STDMETHODCALLTYPE AddRef() override {return 1;}
    ULONG STDMETHODCALLTYPE Release() override {return 1;}
    HRESULT STDMETHODCALLTYPE GetIids(ULONG* count,IID** ids) override {*count=0; *ids=nullptr; return S_OK;}
    HRESULT STDMETHODCALLTYPE GetRuntimeClassName(HSTRING* value) override {
        *value=nullptr; return fail?E_FAIL:WindowsCreateString(name.data(),static_cast<UINT32>(name.size()),value);
    }
    HRESULT STDMETHODCALLTYPE GetTrustLevel(TrustLevel* value) override {*value=FullTrust; return S_OK;}
};
LRESULT CALLBACK windowProc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(message==WM_APP+230){++textNotifications;notificationThread=GetCurrentThreadId();return 0;}
    if(message==taskbar::message) {
        if(window==healthWindow.load()?wp!=healthCookie.load():!taskbar::accepted(endpoint,wp))return 0;
        if(lp==static_cast<LPARAM>(taskbar::Command::Hello)){if(stallHello)Sleep(1000);return 1;}
        received.push_back(static_cast<taskbar::Command>(lp)); return 1;
    }
    return DefWindowProcW(window,message,wp,lp);
}
void drain(){MSG message; while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE))DispatchMessageW(&message);}
DWORD WINAPI healthThread(void*) {
    const HWND window=CreateWindowW(L"WorkUpdatesAdapterIsolatedTest",L"",WS_POPUP,0,0,0,0,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
    healthWindow.store(window);MSG message;
    while(GetMessageW(&message,nullptr,0,0)>0){DispatchMessageW(&message);if(!IsWindow(window))break;}
    return 0;
}
}
int main() {
    using namespace test;
    try {
        Sender weather(L"Taskbar.AugmentedEntryPointButton"),start(L"Taskbar.ExperienceToggleButton"),search(L"Taskbar.SearchBoxButton"),failure(L"Taskbar.AugmentedEntryPointButton");
        failure.fail=true;
        check(taskbar::weatherSender(&weather),"Weather class must route");
        check(!taskbar::weatherSender(&start),"Start class must pass");
        check(!taskbar::weatherSender(&search),"Search class must pass");
        check(!taskbar::weatherSender(&failure),"Failed inspection must pass");
        check(!taskbar::weatherSender(nullptr),"Null sender must pass");
        check(!taskbar::profileMatches(L"missing.dll"),"Missing profile must refuse");
        check(!taskbar::validateLoaded(GetModuleHandleW(nullptr)),"Own test image must refuse production profile");
        WNDCLASSW wc{}; wc.hInstance=GetModuleHandleW(nullptr); wc.lpszClassName=L"WorkUpdatesAdapterIsolatedTest"; wc.lpfnWndProc=windowProc;
        check(RegisterClassW(&wc)!=0,"Register test control");
        HWND window=CreateWindowW(wc.lpszClassName,L"",WS_POPUP,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);
        check(window!=nullptr,"Create hidden test control");
        auto handler=new textscale::Handler(window,WM_APP+230);void* typed=nullptr;
        check(handler->QueryInterface(textscale::handlerId,&typed)==S_OK&&typed,"Text notification exposes the exact system delegate ABI");static_cast<IUnknown*>(typed)->Release();
        check(handler->QueryInterface(textscale::agileId,&typed)==S_OK&&typed,"Text notification can arrive from the system's background thread");static_cast<IUnknown*>(typed)->Release();
        check(handler->QueryInterface(IID_IInspectable,&typed)==E_NOINTERFACE&&!typed,"Text delegate refuses unrelated interfaces");
        std::thread notification([&]{handler->Invoke(nullptr,nullptr);});notification.join();check(textNotifications==0,"System callback does not mutate the UI from its thread");drain();
        check(textNotifications==1&&notificationThread==GetCurrentThreadId(),"Owned UI thread handles the posted text-size notification");
        handler->detach();handler->Invoke(nullptr,nullptr);drain();check(textNotifications==1,"Detached settings callbacks cannot target a destroyed or reused window");handler->Release();
        const auto testDirectory=std::filesystem::temp_directory_path()/(L"work-updates-adapter-test-"+std::to_wstring(GetCurrentProcessId()));
        std::filesystem::create_directories(testDirectory/L"artifacts");
        endpoint=taskbar::publish(window,testDirectory/L"test-endpoint.exe");
        const auto descriptor=taskbar::endpointPath(testDirectory/L"test-endpoint.exe");taskbar::Endpoint saved{};
        check(taskbar::readEndpoint(descriptor,saved)&&saved.cookie==endpoint.cookie,"Published descriptor has one complete session");
        const HANDLE lockedDescriptor=CreateFileW(descriptor.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        check(lockedDescriptor!=INVALID_HANDLE_VALUE,"Lock only the fixture descriptor against replacement");bool refused=false;
        try{taskbar::publish(window,testDirectory/L"test-endpoint.exe");}catch(const std::exception&){refused=true;}CloseHandle(lockedDescriptor);
        check(refused&&taskbar::readEndpoint(descriptor,saved)&&saved.cookie==endpoint.cookie,"Failed publication preserves the last complete session");
        const auto previous=endpoint;endpoint=taskbar::publish(window,testDirectory/L"test-endpoint.exe");
        check(endpoint.cookie!=previous.cookie&&!taskbar::accepted(endpoint,previous.cookie),"A replacement instance refuses the obsolete session cookie");
        auto invalid=endpoint;invalid.version=2;
        {std::ofstream file(descriptor,std::ios::binary|std::ios::trunc);file.write(reinterpret_cast<const char*>(&invalid),sizeof(invalid));}
        saved=endpoint;check(!taskbar::readEndpoint(descriptor,saved)&&saved.cookie==endpoint.cookie,"Unsupported descriptors do not overwrite the current session");
        {std::ofstream file(descriptor,std::ios::binary|std::ios::trunc);file.write(reinterpret_cast<const char*>(&endpoint),sizeof(endpoint));file.put('x');}
        check(!taskbar::readEndpoint(descriptor,saved),"Oversized descriptors are refused");
        {std::ofstream file(descriptor,std::ios::binary|std::ios::trunc);file.put('x');}
        check(!taskbar::readEndpoint(descriptor,saved),"Partial descriptors are refused");
        check(!taskbar::readEndpoint(testDirectory/L"artifacts",saved),"Directories are refused as descriptors");
        endpoint=taskbar::publish(window,testDirectory/L"test-endpoint.exe");
        check(SendMessageW(window,taskbar::message,endpoint.cookie,static_cast<LPARAM>(taskbar::Command::Hello))==1,"Session hello accepted");
        check(SendMessageW(window,taskbar::message,endpoint.cookie^1,static_cast<LPARAM>(taskbar::Command::Hello))==0,"Forged session hello rejected");
        panelProcess=OpenProcess(SYNCHRONIZE,FALSE,GetCurrentProcessId());
        check(panelProcess!=nullptr,"Own process lease");
        check(MH_Initialize()==MH_OK,"Initialize real trampoline engine");
        check(MH_CreateHook(reinterpret_cast<void*>(&hover),reinterpret_cast<void*>(&hoverHook),reinterpret_cast<void**>(&originalHover))==MH_OK,"Hook isolated hover function");
        check(MH_CreateHook(reinterpret_cast<void*>(&click),reinterpret_cast<void*>(&taskbarClickHook),reinterpret_cast<void**>(&originalTaskbarClick))==MH_OK,"Hook isolated taskbar click");
        check(MH_CreateHook(reinterpret_cast<void*>(&leave),reinterpret_cast<void*>(&leaveHook),reinterpret_cast<void**>(&originalLeave))==MH_OK,"Hook isolated leave");
        check(MH_EnableHook(MH_ALL_HOOKS)==MH_OK,"Enable isolated hooks");
        IInspectable* sender=&weather; IInspectable* args=nullptr; void* object=&weather;
        volatile Hover callHover=&hover; volatile Click callClick=&click,callLaunch=&launch; volatile Leave callLeave=&leave;
        callHover(object); callClick(object,sender,args); drain();
        check(hoverCalls==1 && taskbarClicks==1 && received.empty(),"Disconnected adapter preserves real originals");
        check(!health.fresh(GetTickCount64()),"An unacknowledged health lease must fail open");
        healthCookie=endpoint.cookie;
        const HANDLE healthWorker=CreateThread(nullptr,0,healthThread,nullptr,0,nullptr);check(healthWorker!=nullptr,"Create own health window thread");
        for(unsigned i=0;i<40&&!healthWindow.load();++i)Sleep(25);check(healthWindow.load()!=nullptr,"Own health window is ready");
        const auto originalWindow=endpoint.window;endpoint.window=reinterpret_cast<std::uintptr_t>(healthWindow.load());
        check(panelHealthy(),"Fresh cookie and responsive panel renew health");
        endpoint.pid^=1;check(!panelHealthy(),"A window from another PID does not renew health");endpoint.pid^=1;
        endpoint.cookie^=1;check(!panelHealthy(),"Wrong cookie does not renew health");endpoint.cookie^=1;
        stallHello=true;const auto probeAt=GetTickCount64();check(!panelHealthy(),"Hung live panel fails bounded health probe");
        check(GetTickCount64()-probeAt<700,"Health timeout stays bounded on its worker");stallHello=false;
        PostMessageW(healthWindow.load(),WM_CLOSE,0,0);check(WaitForSingleObject(healthWorker,2500)==WAIT_OBJECT_0,"Hung fixture resumes and exits without termination");CloseHandle(healthWorker);
        endpoint.window=originalWindow;
        health.acknowledge(GetTickCount64());connected=true;
        callHover(object); callClick(object,sender,args); callLaunch(object,sender,args); drain();
        check(hoverCalls==1 && taskbarClicks==1 && launchClicks==1,"Only connected weather invokes skip originals");
        check(received.size()==2 && received[0]==taskbar::Command::Hover && received[1]==taskbar::Command::Click,"Ordered async weather commands");
        sender=&start; callClick(object,sender,args); callLaunch(object,sender,args);
        sender=&search; callClick(object,sender,args);
        sender=&failure; callClick(object,sender,args); drain();
        check(taskbarClicks==4 && launchClicks==2 && received.size()==2,"Unrelated and uninspectable buttons preserve originals");
        callLeave(object,args); drain();
        check(leaveCalls==1 && received.back()==taskbar::Command::Leave,"Leave keeps original cleanup and reports dismissal");
        const auto count=received.size(); callLeave(object,args); drain();
        check(leaveCalls==2 && received.size()==count,"Unrelated leave does not send extra dismissals");
        sender=&weather;health.acknowledge(GetTickCount64()-taskbar::healthLeaseMs-1);callHover(object);callClick(object,sender,args);drain();
        check(hoverCalls==2&&taskbarClicks==5&&received.size()==count,"Expired health cannot consume weather commands while the process still lives");
        health.acknowledge(GetTickCount64()+1000);check(!health.fresh(GetTickCount64()),"Future health acknowledgements are refused");
        health.acknowledge(GetTickCount64());
        connected=false; sender=&weather; callHover(object); callClick(object,sender,args); drain();
        check(hoverCalls==3 && taskbarClicks==6 && received.size()==count,"Lease removal passes originals immediately");
        connected=true; DestroyWindow(window); callHover(object); callClick(object,sender,args);
        check(hoverCalls==4 && taskbarClicks==7,"Destroyed endpoint fails open to Widgets originals");
        connected=false;
        check(MH_DisableHook(MH_ALL_HOOKS)==MH_OK,"Disable isolated hooks");
        callHover(object); callClick(object,sender,args);
        check(hoverCalls==5 && taskbarClicks==8,"Disabled function entries restored");
        check(MH_Uninitialize()==MH_OK,"Clean isolated hooks");
        CloseHandle(panelProcess); panelProcess=nullptr;
        std::filesystem::remove(testDirectory/L"artifacts/taskbar-adapter.info");
        std::filesystem::remove(testDirectory/L"artifacts"); std::filesystem::remove(testDirectory);
        std::cout<<"PASS "<<checks<<" adapter checks; real detours exercised only in isolated test process\n";
        return 0;
    } catch(const std::exception& error) {std::cerr<<"FAIL "<<error.what()<<"\n"; return 1;}
}
