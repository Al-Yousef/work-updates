#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <commctrl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <cstring>
#include "../vendor/nlohmann/json.hpp"
#include "../src/chat-layout.h"
#include "../src/ui-audit.h"
#include "bounded-picker-wait.h"
using Json=nlohmann::json;
namespace {
DWORD ownPid=0;HWND panel=nullptr,control=nullptr,editor=nullptr,fileDialog=nullptr;unsigned checks=0;
void check(bool value,const char* label){++checks;if(!value)throw std::runtime_error(label);}
BOOL CALLBACK find(HWND window,LPARAM){
    DWORD pid=0;GetWindowThreadProcessId(window,&pid);if(pid!=ownPid)return TRUE;
    wchar_t name[100]{};GetClassNameW(window,name,100);
    if(!wcscmp(name,L"NativeHoverPanel"))panel=window;
    if(!wcscmp(name,L"NativeHoverTrigger"))control=window;
    if(!wcscmp(name,L"#32770")&&IsWindowVisible(window)&&GetWindow(window,GW_OWNER)==panel){
        wchar_t title[128]{};GetWindowTextW(window,title,128);
        if(!wcscmp(title,L"Attach images"))fileDialog=window;
    }
    return TRUE;
}
void waitForPicker(const PROCESS_INFORMATION& child,const std::filesystem::path& trace,const char* label){
    const auto started=GetTickCount64();fileDialog=nullptr;
    const bool ready=qa::waitForPicker(10000,[]{return GetTickCount64();},[]{fileDialog=nullptr;EnumWindows(find,0);return fileDialog!=nullptr;},
        [](std::uint64_t ms){Sleep(static_cast<DWORD>(ms));},[&]{return WaitForSingleObject(child.hProcess,0)!=WAIT_TIMEOUT;});
    std::ofstream out(trace.parent_path()/L"picker-observations.jsonl",std::ios::app);
    out<<Json({{"schema",1},{"input","simulated"},{"pid",ownPid},{"label",label},{"elapsedMs",GetTickCount64()-started},
        {"openingActions",1},{"retries",0},{"ready",ready},{"childExited",WaitForSingleObject(child.hProcess,0)!=WAIT_TIMEOUT},
        {"panelExists",IsWindow(panel)!=FALSE},{"dialogOwned",ready&&GetWindow(fileDialog,GW_OWNER)==panel}}).dump()<<'\n';
    check(static_cast<bool>(out),"Retain bounded owned-picker observation evidence");check(ready,label);
}
void pickerWaitContract(){
    std::uint64_t clock=0;unsigned polls=0;
    check(qa::waitForPicker(10000,[&]{return clock;},[&]{++polls;return clock>=4500;},[&](auto ms){clock+=ms;},[]{return false;}),"Cold picker readiness after three seconds stays within the finite observation budget");
    check(clock>=4500&&clock<10000&&polls<300,"Cold wait remains bounded without replaying an opening action");
    clock=0;polls=0;
    check(!qa::waitForPicker(10000,[&]{return clock;},[&]{++polls;return false;},[&](auto ms){clock+=ms;},[]{return false;}),"Missing owned picker fails at the finite deadline");
    check(clock==10000&&polls==250,"Timeout never starts another opening action");
    clock=0;polls=0;
    check(!qa::waitForPicker(10000,[&]{return clock;},[&]{++polls;return false;},[&](auto ms){clock+=ms;},[&]{return clock>=120;}),"Exited child cancels observation");
    check(polls==3&&clock==120,"Child exit prevents further polling");
}
Json last(const std::filesystem::path& path){
    std::ifstream input(path);std::string line;Json latest;
    while(std::getline(input,line)){try {auto value=Json::parse(line);if(value.value("pid",0UL)==ownPid)latest=std::move(value);}catch(...){}}
    return latest;
}
bool eventSince(const std::filesystem::path& path,std::streamoff offset,const char* event){
    std::ifstream input(path);input.seekg(offset);std::string line;
    while(std::getline(input,line)){try{auto value=Json::parse(line);if(value.value("pid",0UL)==ownPid&&value.value("event","")==event)return true;}catch(...){}}
    return false;
}
void await(const std::filesystem::path& trace,auto predicate,const char* label){
    for(int i=0;i<100;++i){auto state=last(trace);if(state.is_object()&&predicate(state)){++checks;return;}Sleep(40);}
    throw std::runtime_error(label);
}
void click(int x,int y){
    RECT bounds{};GetClientRect(panel,&bounds);const double scale=bounds.right/chatlayout::width;
    DWORD_PTR ignored=0;
    check(SendMessageTimeoutW(panel,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(static_cast<int>(x*scale),static_cast<int>(y*scale)),
        SMTO_ABORTIFHUNG,2000,&ignored)!=0,"Own panel press dispatch completes");
    check(SendMessageTimeoutW(panel,WM_LBUTTONUP,0,MAKELPARAM(static_cast<int>(x*scale),static_cast<int>(y*scale)),
        SMTO_ABORTIFHUNG,2000,&ignored)!=0,"Own panel click dispatch completes");
}
LPARAM actionPoint(AuditAction action){
    DWORD_PTR value=0;check(SendMessageTimeoutW(panel,WM_APP+211,static_cast<WPARAM>(action),0,SMTO_ABORTIFHUNG,2000,&value)!=0,"Own native audit reads a visible control target");
    check(value!=0,"Required control is actually available in this window");return static_cast<LPARAM>(value);
}
void clickAction(AuditAction action){const auto p=actionPoint(action);click(LOWORD(p),HIWORD(p));}
void menuAction(AuditAction menu,AuditAction action){clickAction(menu);clickAction(action);}
void postAction(AuditAction action){const auto p=actionPoint(action);RECT bounds{};GetClientRect(panel,&bounds);const double scale=bounds.right/chatlayout::width;
    PostMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(static_cast<int>(LOWORD(p)*scale),static_cast<int>(HIWORD(p)*scale)));
    PostMessageW(panel,WM_LBUTTONUP,0,MAKELPARAM(static_cast<int>(LOWORD(p)*scale),static_cast<int>(HIWORD(p)*scale)));}
LPARAM clientPoint(int x,int y){RECT box{};GetClientRect(panel,&box);return MAKELPARAM(static_cast<int>(x*box.right/chatlayout::width),static_cast<int>(y*box.right/chatlayout::width));}
HWND actualFocus(){GUITHREADINFO info{};info.cbSize=sizeof(info);check(GetGUIThreadInfo(GetWindowThreadProcessId(panel,nullptr),&info)!=0,"Inspect the audit child's actual keyboard focus");return info.hwndFocus;}
struct ClipboardBackup {
    std::vector<std::pair<UINT,std::vector<unsigned char>>> formats;bool saved=false;
    bool capture(){if(!OpenClipboard(panel))return false;bool okay=true;SIZE_T total=0;
        for(UINT format=EnumClipboardFormats(0);format;format=EnumClipboardFormats(format)){
            if(format==CF_BITMAP||format==CF_PALETTE||format==CF_METAFILEPICT||format==CF_ENHMETAFILE||format==CF_OWNERDISPLAY||format==CF_DSPBITMAP||format==CF_DSPMETAFILEPICT||format==CF_DSPENHMETAFILE){okay=false;break;}
            auto memory=GetClipboardData(format);const auto size=memory?GlobalSize(memory):0;auto bytes=memory?GlobalLock(memory):nullptr;
            if(!size||!bytes||size>64*1024*1024-total){if(bytes)GlobalUnlock(memory);okay=false;break;}
            formats.push_back({format,std::vector<unsigned char>(static_cast<unsigned char*>(bytes),static_cast<unsigned char*>(bytes)+size)});total+=size;GlobalUnlock(memory);
        }CloseClipboard();saved=okay;if(!okay)formats.clear();return okay;
    }
    bool restore(){if(!saved)return true;if(!OpenClipboard(panel))return false;bool okay=EmptyClipboard()!=0;
        for(const auto& [format,bytes]:formats){auto memory=GlobalAlloc(GMEM_MOVEABLE,bytes.size());auto data=memory?GlobalLock(memory):nullptr;
            if(!data){if(memory)GlobalFree(memory);okay=false;continue;}memcpy(data,bytes.data(),bytes.size());GlobalUnlock(memory);if(!SetClipboardData(format,memory)){GlobalFree(memory);okay=false;}}
        CloseClipboard();if(okay)saved=false;return okay;
    }
    ~ClipboardBackup(){if(saved)restore();}
};
void wheel(int x,int y,int delta){RECT bounds{};GetClientRect(panel,&bounds);const double scale=bounds.right/chatlayout::width;
    POINT point{static_cast<LONG>(x*scale),static_cast<LONG>(y*scale)};ClientToScreen(panel,&point);
    SendMessageW(panel,WM_MOUSEWHEEL,MAKEWPARAM(0,static_cast<WORD>(delta)),MAKELPARAM(point.x,point.y));}
std::wstring draft() {
    wchar_t value[12002]{};
    SendMessageW(editor,WM_GETTEXT,12002,reinterpret_cast<LPARAM>(value));return value;
}
void setDraft(const wchar_t* value) {
    check(SendMessageW(editor,WM_SETTEXT,0,reinterpret_cast<LPARAM>(value))!=0,"Native editor accepts a draft");
}
void enter() {
    SendMessageW(editor,WM_KEYDOWN,VK_RETURN,1);
    SendMessageW(editor,WM_CHAR,L'\r',1);
    SendMessageW(editor,WM_KEYUP,VK_RETURN,1);
}
Json read(const std::filesystem::path& file) {std::ifstream input(file);return Json::parse(input);}
struct FileField {HWND window=nullptr;LONG top=-100000;};
BOOL CALLBACK describeField(HWND child,LPARAM){wchar_t name[80]{};GetClassNameW(child,name,80);RECT box{};GetWindowRect(child,&box);
    std::wcerr<<L"Picker child "<<name<<L" id="<<GetDlgCtrlID(child)<<L" visible="<<IsWindowVisible(child)<<L" rect="<<box.left<<L","<<box.top<<L","<<box.right<<L","<<box.bottom<<L" style="<<GetWindowLongW(child,GWL_STYLE)<<L"\n";return TRUE;}
BOOL CALLBACK fileField(HWND child,LPARAM value){wchar_t name[60]{};GetClassNameW(child,name,60);if(!wcscmp(name,L"Edit")&&IsWindowVisible(child)&&!(GetWindowLongW(child,GWL_STYLE)&ES_READONLY)){
    RECT box{};GetWindowRect(child,&box);auto& field=*reinterpret_cast<FileField*>(value);if(box.top>field.top){field.window=child;field.top=box.top;}}
    return TRUE;
}
void selectSource(const std::filesystem::path& trace,const std::filesystem::path& directory,const char* suffix) {

    auto cards=read(directory/L"view.json").at("cards");
    for(size_t i=0;i<cards.size();++i) {
        auto id=cards[i].value("primarySourceId","");
        if(id.ends_with(suffix)) {check(i<chatlayout::visibleRows,"Fixture source is in the first page");click(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight*(i+.5f)));
            await(trace,[](auto s){return s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true)&&s.value("composerVisible",false);},"Native editor appears in selected chat");return;}
    }
    throw std::runtime_error("Fixture source not found");
}
}
int wmain(int argc,wchar_t** argv){
    PROCESS_INFORMATION child{};
    try {
        pickerWaitContract();
        check(argc==2,"Provide isolated demo backend descriptor");
        wchar_t own[32768]{};GetModuleFileNameW(nullptr,own,32768);
        auto directory=std::filesystem::path(own).parent_path();
        auto native=directory/L"Native Hover.exe",trace=directory/L"artifacts/native-hover.jsonl";
        const auto fixture=std::filesystem::path(argv[1]).parent_path();
        const int initialCount=std::filesystem::exists(fixture/L"fixture-ready.json")?read(fixture/L"fixture-ready.json").value("cards",3):3;
        const auto screenshot=directory/L"artifacts/messages-reference-chat.png";
        std::wstring command=L"\""+native.wstring()+L"\" --isolated-session --no-auto-attach --show --audit-capture \""+screenshot.wstring()+L"\" --bridge \""+argv[1]+L"\"";
        STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
        check(CreateProcessW(native.c_str(),command.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&child)!=0,"Launch own native audit child");
        ownPid=child.dwProcessId;CloseHandle(child.hThread);
        await(trace,[initialCount](auto s){return s.value("queueConnected",false)&&s.value("queueCards",0)==initialCount;},"Real native subscription receives demo queue");
        EnumWindows(find,0);check(panel&&control,"Find only this audit child's windows");
        const auto firstPoint=clientPoint(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight/2));
        const auto secondPoint=clientPoint(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight*1.5f));
        SendMessageW(panel,WM_LBUTTONUP,0,firstPoint);check(!last(trace).value("selected",true),"A release without a press cannot open a chat");
        SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,firstPoint);check(last(trace).value("pointerPressed",false),"The native press state is recorded before activation");
        SendMessageW(panel,WM_MOUSEMOVE,MK_LBUTTON,secondPoint);SendMessageW(panel,WM_LBUTTONUP,0,secondPoint);
        check(!last(trace).value("selected",true)&&!last(trace).value("pointerPressed",true),"Dragging from one chat to another cannot open either chat");
        SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,firstPoint);SendMessageW(panel,WM_CANCELMODE,0,0);SendMessageW(panel,WM_LBUTTONUP,0,firstPoint);
        check(!last(trace).value("selected",true),"Losing pointer capture cancels activation");
        click(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight/2));
        await(trace,[](auto s){return s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true);},"Card click loads details");
        DWORD_PTR captureResult=0;
        check(SendMessageTimeoutW(panel,WM_APP+210,0,0,SMTO_ABORTIFHUNG,3000,&captureResult)!=0,"Capture selected source with its persistent sidebar");
        std::filesystem::copy_file(screenshot,directory/L"artifacts/messages-reference-source-chat.png",std::filesystem::copy_options::overwrite_existing);
        if(std::filesystem::exists(fixture/L"fixture-ready.json")){
            DWORD_PTR groupGeometry=0;check(SendMessageTimeoutW(panel,WM_APP+214,0,0,SMTO_ABORTIFHUNG,2000,&groupGeometry)!=0,"Read the actual visible balloon group geometry");
            check(LOWORD(groupGeometry)==4&&HIWORD(groupGeometry)==2,"Four visible messages in two role groups paint exactly two terminal tails");
        }
        clickAction(AuditAction::DetailsMenu);
        check(last(trace).value("menuOpen",false)&&!IsWindowVisible(GetDlgItem(panel,201)),"Contact name opens details without native fields covering the menu");
        check(SendMessageTimeoutW(panel,WM_APP+210,0,0,SMTO_ABORTIFHUNG,3000,&captureResult)!=0,"Capture the real task details menu");
        std::filesystem::copy_file(screenshot,directory/L"artifacts/messages-reference-details.png",std::filesystem::copy_options::overwrite_existing);
        SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);
        check(!last(trace).value("menuOpen",true)&&last(trace).value("selected",false),"Escape closes details while keeping the conversation selected");
        clickAction(AuditAction::FilterMenu);SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(screenshot,directory/L"artifacts/iphone-components-filters.png",std::filesystem::copy_options::overwrite_existing);SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);
        const auto replies=last(trace).value("commandReplies",0U);
        menuAction(AuditAction::DetailsMenu,AuditAction::Open);
        await(trace,[replies](auto s){return s.value("commandReplies",0U)>replies&&s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true);},"Open command completes without replacing selected task");
        menuAction(AuditAction::DetailsMenu,AuditAction::Reviewed);
        await(trace,[initialCount](auto s){return !s.value("selected",true)&&s.value("queueCards",0)==initialCount-1&&!s.value("pending",true);},"Reviewed removes exactly one card");
        menuAction(AuditAction::FilterMenu,AuditAction::Undo);
        await(trace,[initialCount](auto s){return s.value("queueCards",0)==initialCount&&!s.value("pending",true);},"Undo restores the queue");
        click(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight/2));
        await(trace,[](auto s){return s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true);},"Select restored task");
        menuAction(AuditAction::DetailsMenu,AuditAction::Snooze);
        await(trace,[initialCount](auto s){return !s.value("selected",true)&&s.value("queueCards",0)==initialCount-1&&!s.value("pending",true);},"Snooze removes exactly one card");
        menuAction(AuditAction::FilterMenu,AuditAction::History); // History
        Sleep(100);click(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight/2));
        await(trace,[](auto s){return s.value("selected",false)&&s.value("queueCards",0)==1&&!s.value("pending",true);},"History retains snoozed task context");
        clickAction(AuditAction::Assistant); // Back
        menuAction(AuditAction::FilterMenu,AuditAction::Updates); // Updates
        menuAction(AuditAction::FilterMenu,AuditAction::Undo); // Undo snooze
        await(trace,[initialCount](auto s){return !s.value("selected",true)&&s.value("queueCards",0)==initialCount&&!s.value("pending",true);},"Undo snooze restores original view");
        if(std::filesystem::exists(fixture/L"fixture-ready.json")) {
            editor=GetDlgItem(panel,201);check(editor!=nullptr,"Actual native EDIT control exists");
            selectSource(trace,fixture,"000002");
            setDraft(L"Keep my draft if Codex owns this chat");
            const auto failedReplies=last(trace).value("commandReplies",0U);enter();
            await(trace,[failedReplies](auto s){return s.value("commandReplies",0U)>failedReplies&&!s.value("pending",true);},"Writer refusal returns without a stuck send");
            check(draft()==L"Keep my draft if Codex owns this chat","Writer refusal preserves editor text");
            check(!std::filesystem::exists(fixture/L"sent.json"),"Refused writer receives no message");
            auto search=GetDlgItem(panel,202);check(search&&IsWindowVisible(search),"The sidebar search is an actual native input");
            RECT searchBounds{},clientBounds{};GetWindowRect(search,&searchBounds);POINT searchOrigin{searchBounds.left,searchBounds.top};ScreenToClient(panel,&searchOrigin);GetClientRect(panel,&clientBounds);
            check(searchOrigin.y>clientBounds.bottom*.9&&searchBounds.right-searchBounds.left>clientBounds.right*.2,"The real Search field is at the bottom and retains usable typing width");
            const auto headerPoint=actionPoint(AuditAction::DetailsMenu);check(HIWORD(headerPoint)==56,"The landscape contact target is one inline header row");
            POINT headerScreen{static_cast<LONG>(LOWORD(headerPoint)*clientBounds.right/chatlayout::width),static_cast<LONG>(HIWORD(headerPoint)*clientBounds.right/chatlayout::width)};ClientToScreen(panel,&headerScreen);
            check(SendMessageW(panel,WM_NCHITTEST,0,MAKELPARAM(headerScreen.x,headerScreen.y))==HTCLIENT,"The real contact header receives clicks instead of window dragging");
            SendMessageW(search,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L"INTERFACE"));
            check(last(trace).value("queueCards",0)==1&&draft()==L"Keep my draft if Codex owns this chat","Search matches case-insensitively without switching or clearing the draft");
            SendMessageW(search,WM_KEYDOWN,VK_RETURN,0);SendMessageW(search,WM_CHAR,L'\r',0);
            check(!std::filesystem::exists(fixture/L"sent.json"),"Return in Search cannot send the selected chat's draft");
            SendMessageW(search,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L"no-fixture-matches-this"));
            check(last(trace).value("queueCards",-1)==0&&draft()==L"Keep my draft if Codex owns this chat","No-results search preserves the displayed chat and its draft");
            SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(screenshot,directory/L"artifacts/iphone-components-no-results.png",std::filesystem::copy_options::overwrite_existing);
            SendMessageW(search,WM_KEYDOWN,VK_ESCAPE,0);
            check(last(trace).value("queueCards",0)==initialCount&&draft()==L"Keep my draft if Codex owns this chat","Escape clears Search without changing the draft");
            SendMessageW(search,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L"INTERFACE"));
            SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(screenshot,directory/L"artifacts/iphone-ux-search.png",std::filesystem::copy_options::overwrite_existing);clickAction(AuditAction::ClearSearch);
            check(actualFocus()==search&&last(trace).value("queueCards",0)==initialCount&&draft()==L"Keep my draft if Codex owns this chat","The Clear button restores the list, keeps Search focused and preserves the chat draft");
            selectSource(trace,fixture,"000001");check(draft().empty(),"Another source has its own empty draft");
            selectSource(trace,fixture,"000002");check(draft()==L"Keep my draft if Codex owns this chat","Back and chat switches preserve the failed draft");
            selectSource(trace,fixture,"000001");
            RECT singleLineBox{};GetWindowRect(editor,&singleLineBox);
            setDraft(L"First line\r\nSecond line 漢字 😀");
            RECT multilineBox{};GetWindowRect(editor,&multilineBox);
            check(multilineBox.bottom-multilineBox.top>singleLineBox.bottom-singleLineBox.top,"Multiline text grows the actual native editor before sending");
            SendMessageW(editor,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(8,8));SendMessageW(editor,WM_LBUTTONUP,0,MAKELPARAM(8,8));
            check(actualFocus()==editor,"Clicking the composer focuses the actual native editor");
            const auto pressTraceOffset=static_cast<std::streamoff>(std::filesystem::file_size(trace));
            const auto heldSend=actionPoint(AuditAction::Send);SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,clientPoint(LOWORD(heldSend),HIWORD(heldSend)));
            const auto beforeKeyboardSwitch=last(trace).value("composerKey","");for(int tab=0;tab<4;++tab)SendMessageW(panel,WM_KEYDOWN,VK_TAB,0);SendMessageW(panel,WM_KEYDOWN,VK_RETURN,0);
            await(trace,[beforeKeyboardSwitch](auto s){return s.value("composerKey","")!=beforeKeyboardSwitch&&s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true);},"Keyboard navigation changes the chat during a held Send press");
            check(draft()!=L"First line\r\nSecond line 漢字 😀","Keyboard selection during the press displays a different chat's draft");setDraft(L"Keep this new selected chat draft");
            const auto repliesAfterSwitch=last(trace).value("commandReplies",0U);SendMessageW(panel,WM_LBUTTONUP,0,clientPoint(LOWORD(heldSend),HIWORD(heldSend)));
            // Native focus/capture changes can cancel before mouse-up; a later
            // navigation log must not turn that correct cancellation into a failure.
            check(last(trace).value("commandReplies",0U)==repliesAfterSwitch&&!last(trace).value("pending",true)&&!last(trace).value("pointerPressed",true)&&eventSince(trace,pressTraceOffset,"ui-press-cancelled")&&!std::filesystem::exists(fixture/L"sent.json")&&draft()==L"Keep this new selected chat draft","A canceled Send press cannot submit another source's draft");
            selectSource(trace,fixture,"000001");check(draft()==L"First line\r\nSecond line 漢字 😀","Canceled Send preserves the original chat's draft too");
            SendMessageW(editor,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(8,8));SendMessageW(editor,WM_LBUTTONUP,0,MAKELPARAM(8,8));
            SendMessageW(editor,EM_SETSEL,3,8);const auto addPoint=actionPoint(AuditAction::AddMenu);
            SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,clientPoint(LOWORD(addPoint),HIWORD(addPoint)));SendMessageW(panel,WM_APP+210,0,0);
            std::filesystem::copy_file(screenshot,directory/L"artifacts/iphone-ux-pressed.png",std::filesystem::copy_options::overwrite_existing);
            SendMessageW(panel,WM_LBUTTONUP,0,clientPoint(LOWORD(addPoint),HIWORD(addPoint)));SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);
            DWORD selectionStart=0,selectionEnd=0;SendMessageW(editor,EM_GETSEL,reinterpret_cast<WPARAM>(&selectionStart),reinterpret_cast<LPARAM>(&selectionEnd));
            check(actualFocus()==editor&&selectionStart==3&&selectionEnd==8,"Escape from a menu restores the composer and its exact selection");
            const auto repliesBeforeDismiss=last(trace).value("commandReplies",0U);clickAction(AuditAction::AddMenu);click(690,400);
            check(!last(trace).value("menuOpen",true)&&actualFocus()==editor&&last(trace).value("commandReplies",0U)==repliesBeforeDismiss,"Outside menu dismissal restores typing without dispatching a command");
            SendMessageW(panel,WM_SETTINGCHANGE,0,0);check(draft()==L"First line\r\nSecond line 漢字 😀","Display/layout refresh preserves the editor text");
            RECT editBox{},panelBox{};GetWindowRect(editor,&editBox);GetWindowRect(panel,&panelBox);
            check(editBox.left>panelBox.left+(panelBox.right-panelBox.left)*chatlayout::sidebarRight/chatlayout::width&&editBox.right<panelBox.right-25,"Layout refresh keeps the editor inside the conversation pane");
            const auto successReplies=last(trace).value("commandReplies",0U);enter();enter();
            await(trace,[successReplies](auto s){return s.value("commandReplies",0U)>successReplies&&!s.value("replyPending",true);},"Native Enter receives a send receipt");
            check(draft().empty(),"Confirmed send clears the submitted draft");
            auto sent=read(fixture/L"sent.json");check(sent.size()==1,"Repeated Enter sends exactly once");
            check(sent[0]["threadId"]=="10000000-0000-4000-8000-000000000001","Reply targets the displayed source chat");
            check(sent[0]["text"]=="First line\r\nSecond line 漢字 😀","Multiline and Unicode input reaches the backend intact");
            Sleep(700); // Complete the deterministic sample pass before the next send.
            setDraft(L"Send button follow-up");const auto buttonReplies=last(trace).value("commandReplies",0U);
            clickAction(AuditAction::Send);
            await(trace,[buttonReplies](auto s){return s.value("commandReplies",0U)>buttonReplies&&!s.value("replyPending",true);},"Send button receives its receipt");
            sent=read(fixture/L"sent.json");check(sent.size()==2,"Send button delivers one follow-up");
            check(sent[1]["threadId"]==sent[0]["threadId"],"Adopted task continues the same chat");
            check(draft().empty(),"Send button clears only after confirmation");
            setDraft(L"Queue button follow-up");const auto queueReplies=last(trace).value("commandReplies",0U);
            check(SendMessageTimeoutW(panel,WM_APP+210,0,0,SMTO_ABORTIFHUNG,3000,&captureResult)!=0,"Capture active chat primary Queue action");
            std::filesystem::copy_file(screenshot,directory/L"artifacts/messages-reference-queue.png",std::filesystem::copy_options::overwrite_existing);
            clickAction(AuditAction::Send);
            await(trace,[queueReplies](auto s){return s.value("commandReplies",0U)>queueReplies&&!s.value("replyPending",true)&&!s.value("pending",true);},"Queue button receives durable receipt");
            check(draft().empty(),"Queued reply clears its editor only after storage succeeds");
            auto stored=read(fixture/L"messages.json");check(stored["entries"].size()==1,"Queue button creates one durable entry");
            check(stored["entries"][0]["text"]=="Queue button follow-up","Durable queue retains exact draft");
            check(stored["entries"][0]["sourceId"]==sent[0]["threadId"],"Queued message retains its displayed source");
            check(read(fixture/L"sent.json").size()==2,"Queuing alone does not send a third message");
            await(trace,[](auto s){return s.value("queuedMessages",0)==1&&!s.value("pending",true);},"Queued entry is visible before clearing it");
            const auto clearReplies=last(trace).value("commandReplies",0U);menuAction(AuditAction::DetailsMenu,AuditAction::ClearQueue);
            await(trace,[clearReplies](auto s){return s.value("commandReplies",0U)>clearReplies&&s.value("queuedMessages",1)==0&&!s.value("pending",true);},"Clear queue acknowledgement updates the visible state");
            check(read(fixture/L"messages.json")["entries"][0]["status"]=="cancelled","Clear queue cancels its pending entry");
            check(read(fixture/L"sent.json").size()==2,"Cancelled queue entry is never dispatched");
            Sleep(700);
            clickAction(AuditAction::Assistant);
            await(trace,[](auto s){return s.value("assistantView",false)&&s.value("composerVisible",false);},"Header Chat opens the native assistant composer");
            check(draft().empty(),"Assistant has a separate draft from source replies");
            setDraft(L"Remember that I prefer concise updates.");const auto memoryReplies=last(trace).value("commandReplies",0U);enter();enter();
            await(trace,[memoryReplies](auto s){return s.value("commandReplies",0U)>memoryReplies&&!s.value("pending",true)&&s.value("assistantMessages",0)==1;},"Enter saves one explicit memory message");
            check(draft().empty(),"Assistant receipt clears only its accepted draft");
            check(read(fixture/L"assistant.json")["notes"][0]=="I prefer concise updates.","Explicit memory is stored in Hyphen");
            check(read(fixture/L"sent.json").size()==2,"Remember does not send to a source chat");
            setDraft(L"Draft a reply for Launch planning");const auto assistantReplies=last(trace).value("commandReplies",0U);clickAction(AuditAction::Send);
            await(trace,[assistantReplies](auto s){return s.value("commandReplies",0U)>assistantReplies&&!s.value("pending",true)&&s.value("assistantResponding",false);},"Assistant Send receives a durable acknowledgement while AI works");
            await(trace,[](auto s){return s.value("assistantMessages",0)==2&&!s.value("assistantResponding",true);},"Assistant answer arrives through the subscription");
            check(draft().empty(),"Assistant submitted question is cleared");
            auto conversation=read(fixture/L"assistant.json");check(conversation["messages"][1]["links"].size()==1,"Assistant answer includes one exact chat draft");
            check(read(fixture/L"sent.json").size()==2,"Generating an assistant draft does not send it");
            clickAction(AuditAction::UseDraft);
            await(trace,[](auto s){return s.value("selected",false)&&!s.value("pending",true)&&!s.value("detailPending",true)&&s.value("composerVisible",false);},"Use draft opens the intended source chat");
            check(draft()==L"Please share the remaining launch review steps.","Use draft prefills the correct native source editor");
            check(read(fixture/L"sent.json").size()==2,"Opening a draft does not dispatch it");
            clickAction(AuditAction::Assistant);
            await(trace,[](auto s){return s.value("assistantView",false)&&s.value("composerVisible",false);},"Back from a related update restores the assistant conversation");
            setDraft(L"Unsent assistant note");menuAction(AuditAction::FilterMenu,AuditAction::Updates);click(148,146);
            check(draft()==L"Unsent assistant note","Updates and Chat switches preserve the assistant draft");
            setDraft(L"Describe this image");const auto imagePath=std::filesystem::weakly_canonical(fixture/L"fixture-image.png").make_preferred().wstring();
            clickAction(AuditAction::AddMenu);postAction(AuditAction::Attach);
            waitForPicker(child,trace,"Native attach button opens its own file picker");
            FileField field;for(int i=0;i<100&&!field.window;i++){EnumChildWindows(fileDialog,fileField,reinterpret_cast<LPARAM>(&field));if(!field.window)Sleep(30);}auto fileName=field.window;
            SendMessageW(GetDlgItem(fileDialog,IDCANCEL),BM_CLICK,0,0);Sleep(120);
            check(draft()==L"Describe this image"&&last(trace).value("draftImages",-1)==0,"Cancelling the owned image picker preserves the draft and adds no image");
            fileDialog=nullptr;clickAction(AuditAction::AddMenu);postAction(AuditAction::Attach);
            waitForPicker(child,trace,"Image picker reopens after cancellation");
            field={};for(int i=0;i<100&&!field.window;i++){EnumChildWindows(fileDialog,fileField,reinterpret_cast<LPARAM>(&field));if(!field.window)Sleep(30);}fileName=field.window;
            if(!fileName)EnumChildWindows(fileDialog,describeField,0);
            check(fileName!=nullptr,"Find the file-name field in this audit child's picker");
            SendMessageW(fileName,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L""));
            for(wchar_t ch:imagePath)SendMessageW(fileName,WM_CHAR,ch,1);
            wchar_t entered[32768]{};SendMessageW(fileName,WM_GETTEXT,32768,reinterpret_cast<LPARAM>(entered));
            if(entered!=imagePath){wchar_t kind[80]{};GetClassNameW(fileName,kind,80);std::wcerr<<L"Picker control: "<<kind<<L" id="<<GetDlgCtrlID(fileName)<<L" entered="<<wcslen(entered)<<L" expected="<<imagePath.size()<<L"\n";}
            check(entered==imagePath,"The file-name editor receives the exact absolute image path");
            SendMessageW(GetDlgItem(fileDialog,IDOK),BM_CLICK,0,0);
            DWORD_PTR ignored=0;
            await(trace,[](auto s){return s.value("draftImages",0)==1&&!s.value("pending",true);},"Native image preview is attached after durable import");
            auto drafts=read(fixture/L"drafts.json");check(drafts["attachments"]["@hyphen"].size()==1,"Image draft persists before Send");
            check(SendMessageTimeoutW(panel,WM_APP+210,0,0,SMTO_ABORTIFHUNG,3000,&ignored)!=0,"Capture actual removable draft image preview");
            const auto draftScreenshot=directory/L"artifacts/messages-reference-chat-draft.png";
            std::filesystem::copy_file(screenshot,draftScreenshot,std::filesystem::copy_options::overwrite_existing);
            check(std::filesystem::exists(draftScreenshot),"Native draft render evidence saved");
            enter();await(trace,[](auto s){return s.value("assistantMessages",0)==3&&!s.value("assistantResponding",true)&&!s.value("pending",true)&&s.value("draftImages",1)==0;},"Image message receives a receipt and response");
            conversation=read(fixture/L"assistant.json");check(conversation["messages"].back()["images"].size()==1,"Received image remains in native conversation history");
            check(read(fixture/L"sent.json").size()==2,"Assistant image does not leak into a source chat");
            check(SendMessageTimeoutW(panel,WM_APP+210,0,0,SMTO_ABORTIFHUNG,3000,&ignored)!=0,"Capture actual native image conversation");
            check(std::filesystem::exists(screenshot),"Native render evidence saved");
            const int conversationBefore=last(trace).value("conversationOffset",0);
            wheel(180,330,-WHEEL_DELTA);
            check(last(trace).value("conversationOffset",0)==conversationBefore,"Wheel over sidebar keeps conversation scroll position");
            const int sidebarAfter=last(trace).value("sidebarOffset",-1);
            if(initialCount>chatlayout::visibleRows)check(sidebarAfter==1,"Sidebar with many chats scrolls while its conversation stays open");
            wheel(650,330,WHEEL_DELTA);
            check(last(trace).value("conversationOffset",0)<conversationBefore,"Wheel over conversation scrolls only its transcript");
            check(last(trace).value("sidebarOffset",-1)==sidebarAfter,"Conversation scroll keeps sidebar position");
            check(!last(trace).value("assistantFollow",true),"Reading older messages pauses assistant transcript following");
            clickAction(AuditAction::Latest);check(last(trace).value("assistantFollow",false),"Latest explicitly resumes transcript following");
            DWORD_PTR bubble=0;check(SendMessageTimeoutW(panel,WM_APP+212,0,0,SMTO_ABORTIFHUNG,2000,&bubble)!=0&&bubble,"The native audit finds a visible text balloon");
            RECT panelBounds{};GetClientRect(panel,&panelBounds);const double bubbleScale=panelBounds.right/chatlayout::width;
            POINT bubblePoint{static_cast<LONG>(LOWORD(bubble)*bubbleScale),static_cast<LONG>(HIWORD(bubble)*bubbleScale)};ClientToScreen(panel,&bubblePoint);
            SendMessageW(panel,WM_CONTEXTMENU,reinterpret_cast<WPARAM>(panel),MAKELPARAM(bubblePoint.x,bubblePoint.y));
            check(last(trace).value("menuOpen",false),"Right-clicking a visible message opens its contextual menu");
            SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(screenshot,directory/L"artifacts/iphone-ux-copy.png",std::filesystem::copy_options::overwrite_existing);
            ClipboardBackup clipboard;if(clipboard.capture()){
                clickAction(AuditAction::CopyMessage);std::wstring copied;if(OpenClipboard(panel)){auto memory=GetClipboardData(CF_UNICODETEXT);auto text=memory?static_cast<const wchar_t*>(GlobalLock(memory)):nullptr;if(text){copied=text;GlobalUnlock(memory);}CloseClipboard();}
                check(clipboard.restore(),"Restore every captured clipboard format after the synthetic Copy test");
                check(copied==L"The launch notes need your review. Here is a draft for that chat.","Copy transfers exactly the chosen visible balloon text");
            }else {std::cout<<"Clipboard contains unsupported handle formats; Copy menu checked without replacing clipboard.\n";SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);}
            if(initialCount>chatlayout::visibleRows){clickAction(AuditAction::Previous);check(last(trace).value("sidebarOffset",-1)==0,"Sidebar previous page restores its first chats");}
        }
        click(static_cast<int>(chatlayout::width-35),33);Sleep(450);check(!IsWindowVisible(panel),"X hides actual native panel");
        PostMessageW(control,WM_CLOSE,0,0);
        check(WaitForSingleObject(child.hProcess,4000)==WAIT_OBJECT_0,"Workers cancel and native app exits gracefully");
        DWORD exit=1;GetExitCodeProcess(child.hProcess,&exit);check(exit==0,"Native exit succeeds");
        CloseHandle(child.hProcess);child.hProcess=nullptr;
        std::cout<<"PASS "<<checks<<" native queue integration checks against a real isolated backend (simulated window input)\n";return 0;
    }catch(const std::exception& error){
        std::cerr<<"FAIL: "<<error.what()<<"\n";
        if(control)PostMessageW(control,WM_CLOSE,0,0);
        if(child.hProcess){if(WaitForSingleObject(child.hProcess,3000)!=WAIT_OBJECT_0)TerminateProcess(child.hProcess,2);CloseHandle(child.hProcess);}
        return 1;
    }
}
