#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <oleacc.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <algorithm>
#include <cmath>
#include "../vendor/nlohmann/json.hpp"
#include "../src/chat-layout.h"
#include "../src/ui-audit.h"
using Json=nlohmann::json;
namespace {
DWORD childPid=0;HWND panel=nullptr,control=nullptr,editor=nullptr,search=nullptr;unsigned checks=0,requestId=0;ULONGLONG deadline=0;
std::filesystem::path fixture,artifacts,capture;IAccessible* accessible=nullptr;
void check(bool okay,const char* label){++checks;if(!okay)throw std::runtime_error(label);}
Json read(const std::filesystem::path& file){std::ifstream in(file);return Json::parse(in);}
BOOL CALLBACK find(HWND hwnd,LPARAM){DWORD pid=0;GetWindowThreadProcessId(hwnd,&pid);if(pid!=childPid)return TRUE;wchar_t name[80]{};GetClassNameW(hwnd,name,80);if(!wcscmp(name,L"NativeHoverPanel"))panel=hwnd;if(!wcscmp(name,L"NativeHoverTrigger"))control=hwnd;return TRUE;}
Json state(){SendMessageW(panel,WM_APP+215,0,0);return read(artifacts/L"ux-state.json");}
void wait(auto condition,const char* label){for(int n=0;n<160;++n){if(deadline&&GetTickCount64()>deadline)throw std::runtime_error("Isolated audit exceeded its deadline");if(condition()){check(true,label);return;}Sleep(40);}throw std::runtime_error(label);}
HWND focus(){GUITHREADINFO i{};i.cbSize=sizeof(i);check(GetGUIThreadInfo(GetWindowThreadProcessId(panel,nullptr),&i)!=0,"Read own child's focus");return i.hwndFocus;}
void fault(const char* op,Json value=Json::object()){std::string id=std::to_string(++requestId);{std::ofstream out(fixture/L"ux-command.json");out<<Json({{"id",id},{"op",op},{"value",value}}).dump();}wait([&]{try{return read(fixture/L"ux-result.json").value("id","")==id;}catch(...){return false;}},"Isolated fixture acknowledges fault injection");}
void click(int x,int y){RECT b{};GetClientRect(panel,&b);const auto p=MAKELPARAM(x*b.right/880,y*b.right/880);SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,p);SendMessageW(panel,WM_LBUTTONUP,0,p);}
void action(AuditAction a){const auto p=SendMessageW(panel,WM_APP+211,static_cast<WPARAM>(a),0);check(p!=0,"Visible enabled action exists");click(LOWORD(p),HIWORD(p));}
std::wstring draft(){wchar_t text[12002]{};SendMessageW(editor,WM_GETTEXT,12002,reinterpret_cast<LPARAM>(text));return text;}
void setDraft(const wchar_t* text){SendMessageW(editor,WM_SETTEXT,0,reinterpret_cast<LPARAM>(text));}
void saveCapture(const wchar_t* name){SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(capture,artifacts/name,std::filesystem::copy_options::overwrite_existing);}
VARIANT child(long id){VARIANT v{};v.vt=VT_I4;v.lVal=id;return v;}
std::wstring name(long id){BSTR text=nullptr;auto hr=accessible->get_accName(child(id),&text);std::wstring result=hr==S_OK&&text?std::wstring(text,SysStringLen(text)):L"";SysFreeString(text);return result;}
std::vector<long> ids(){IEnumVARIANT* e=nullptr;check(SUCCEEDED(accessible->QueryInterface(IID_IEnumVARIANT,reinterpret_cast<void**>(&e))),"Accessible controls enumerate actual stable IDs");e->Reset();std::vector<long> out;VARIANT value{};ULONG count=0;while(e->Next(1,&value,&count)==S_OK){check(value.vt==VT_I4,"Enumeration returns a child ID");out.push_back(value.lVal);VariantClear(&value);}e->Release();return out;}
long named(const std::wstring& text){for(auto id:ids())if(name(id).find(text)!=std::wstring::npos)return id;throw std::runtime_error("Named accessibility child absent");}
void select(long id){check(accessible->accSelect(SELFLAG_TAKEFOCUS,child(id))==S_OK,"Accessible control accepts focus");wait([&]{VARIANT f{};auto hr=accessible->get_accFocus(&f);return hr==S_OK&&f.vt==VT_I4&&f.lVal==id;},"Focus belongs to the same stable identity");}
void drop(const std::vector<std::wstring>& paths){Json value=Json::array();for(const auto& p:paths){const int n=WideCharToMultiByte(CP_UTF8,0,p.data(),static_cast<int>(p.size()),nullptr,0,nullptr,nullptr);std::string text(n,0);WideCharToMultiByte(CP_UTF8,0,p.data(),static_cast<int>(p.size()),text.data(),n,nullptr,nullptr);value.push_back(text);} {std::ofstream out(fixture/L"ux-drop.json");out<<value.dump();}check(SendMessageW(panel,WM_APP+219,0,0)==1,"Own audit child constructs process-local HDROP input");}
}
int wmain(int argc,wchar_t** argv){PROCESS_INFORMATION process{};CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
try {
    check(argc==3||argc==4,"Provide fixture descriptor, rendering DPI and optional status fixtures");fixture=std::filesystem::path(argv[1]).parent_path();const int dpi=_wtoi(argv[2]);
    wchar_t own[32768]{};GetModuleFileNameW(nullptr,own,32768);auto directory=std::filesystem::path(own).parent_path();artifacts=directory/L"artifacts";capture=artifacts/L"ux-current.png";
    std::wstring command=L"\""+(directory/L"Native Hover.exe").wstring()+L"\" --isolated-session --no-auto-attach --show --audit-reduced-motion --audit-dpi "+std::to_wstring(dpi)+L" --audit-capture \""+capture.wstring()+L"\" --bridge \""+argv[1]+L"\"";
    STARTUPINFOW start{};start.cb=sizeof(start);start.dwFlags=STARTF_USESHOWWINDOW;start.wShowWindow=SW_HIDE;
    const bool started=CreateProcessW(nullptr,command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&start,&process);if(!started)std::cerr<<"CreateProcess error "<<GetLastError()<<"\n";check(started,"Start own isolated native window");CloseHandle(process.hThread);childPid=process.dwProcessId;
    wait([]{EnumWindows(find,0);return panel&&control;},"Locate only this test child's windows");editor=GetDlgItem(panel,201);search=GetDlgItem(panel,202);
    wait([]{return state().value("connected",false);},"Initial subscription connects");
    auto initial=state();check(initial.value("dpi",0)==dpi,"Renderer uses the requested isolated scale");check(initial.value("reducedMotion",false),"Reduced-motion policy is exercised without changing Windows settings");
    RECT client{};GetClientRect(panel,&client);check(client.right==dpi*880/96&&client.bottom==dpi*660/96,"Native window uses both scaled dimensions");
    check(SUCCEEDED(AccessibleObjectFromWindow(panel,OBJID_CLIENT,IID_IAccessible,reinterpret_cast<void**>(&accessible))),"Windows exposes the custom native controls through MSAA");
    if(argc==4){
        deadline=GetTickCount64()+55000;
        const auto shared=read(argv[3]);check(shared.value("synthetic",false),"Only synthetic shared status fixtures are accepted");
        for(const auto& sample:shared.at("cases")){
            const auto& card=sample.at("frame").at("cards").at(0);fault("patch",sample.at("frame"));
            action(AuditAction::FilterMenu);action(card.value("status","")=="queued"?AuditAction::Queued:AuditAction::Updates);
            wait([&]{const auto actual=state();for(const auto& hit:actual["hits"])if(hit.value("action","")=="card"&&hit.value("key","").find(card.value("id",""))!=std::string::npos)return true;return false;},"Shared status reaches the painted native list");
            const auto label=sample.at("expected").value("label","");const int length=MultiByteToWideChar(CP_UTF8,0,label.data(),static_cast<int>(label.size()),nullptr,0);std::wstring visible(length,0);MultiByteToWideChar(CP_UTF8,0,label.data(),static_cast<int>(label.size()),visible.data(),length);
            wait([&]{try{return named(visible)>0;}catch(...){return false;}},"Status has a meaningful accessible text label");
            click(180,static_cast<int>(chatlayout::listTop+chatlayout::rowHeight/2));
            wait([&]{auto actual=state();return actual.value("selected","")==card.value("id","")&&!actual.value("detailPending",true);},"Actual source header receives the selected fixture");
            if(card.value("status","")=="queued")check(!IsWindowVisible(editor),"A never-started local task has no chat composer");
            action(AuditAction::DetailsMenu);check(named(L"Mark task done")>0,"Task completion is separate from Reviewed");
            const auto id=sample.value("id","");const auto image=L"status-"+std::wstring(id.begin(),id.end())+L"-"+std::to_wstring(dpi)+L".png";
            saveCapture(image.c_str());SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);
        }
        accessible->Release();accessible=nullptr;PostMessageW(control,WM_CLOSE,0,0);
        check(WaitForSingleObject(process.hProcess,4000)==WAIT_OBJECT_0,"Status fixture child exits normally");DWORD code=1;GetExitCodeProcess(process.hProcess,&code);check(code==0,"Native status render exits successfully");CloseHandle(process.hProcess);process.hProcess=nullptr;
        std::cout<<"PASS "<<shared.at("cases").size()<<" rendered and accessible statuses at "<<dpi<<" DPI (synthetic transport and simulated own-window input)\n";CoUninitialize();return 0;
    }
    action(AuditAction::Assistant);wait([]{return IsWindowVisible(editor);},"Composer is immediately available with reduced motion");
    check(focus()==editor,"Opening a chat focuses Message");
    check((GetWindowLongW(editor,GWL_EXSTYLE)&WS_EX_LAYERED)&&(GetWindowLongW(search,GWL_EXSTYLE)&WS_EX_LAYERED),"Native text fields have independent redirection surfaces above the composition-only parent");
    // Test the visible field's padding, rather than only EDIT's small child HWND.
    SendMessageW(panel,WM_APP+218,1,0);check(focus()==search,"Composer padding test starts with Search focused");
    const auto paddingPoint=MAKELPARAM(std::lround((chatlayout::composerLeft+4)*dpi/96),std::lround(606.0f*dpi/96));
    SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,paddingPoint);
    check(focus()==editor,"Text-field padding gives native caret focus on mouse-down without waiting for release");
    SendMessageW(panel,WM_LBUTTONUP,0,paddingPoint);
    check(focus()==editor&&state().value("composerFocused",false),"Clicking the left text-field padding immediately focuses Message");
    SendMessageW(panel,WM_APP+218,1,0);click(static_cast<int>(chatlayout::composerTextRight+4),600);
    check(focus()==editor,"Clicking the top-right text-field padding focuses Message without hitting Send");
    SendMessageW(panel,WM_APP+218,1,0);click(450,636);
    check(focus()==editor,"Clicking the bottom text-field padding focuses Message");
    auto geometry=state();auto editBounds=geometry.at("composerBoundsPx"),formatBounds=geometry.at("composerFormatPx");
    check(editBounds[2].get<int>()<=std::lround(chatlayout::composerTextRight*dpi/96),"Native Message field stays clear of the Send hit target at this scale");
    check(formatBounds[0].get<int>()>0&&formatBounds[2].get<int>()<editBounds[2].get<int>()-editBounds[0].get<int>(),"Native formatting keeps explicit text margins");
    // Find the real EDIT soft-wrap boundary, then type the crossing character.
    // This detects both delayed growth and measuring with another renderer's font.
    setDraft(L"");int previousLines=1;bool wrapped=false;
    for(int n=0;n<300;++n){
        SendMessageW(editor,WM_CHAR,L'W',1);const int lines=static_cast<int>(SendMessageW(editor,EM_GETLINECOUNT,0,0));
        if(lines>previousLines){wrapped=true;break;}previousLines=lines;
    }
    check(wrapped,"Native editor wraps a long unbroken word");geometry=state();
    check(geometry.value("composerLines",0)==2,"Composer uses the same soft-wrap count as the actual editor");
    const float expected=std::clamp(2*geometry.value("composerLinePixels",0)*96.0f/dpi+2*chatlayout::composerPadding,chatlayout::composerMinHeight,chatlayout::composerMaxHeight);
    check(std::abs(geometry.value("composerHeight",0.0f)-expected)<.1f,"The first wrapping character immediately expands the field by the native line height");
    geometry=state();formatBounds=geometry.at("composerFormatPx");
    check(formatBounds[3].get<int>()-formatBounds[1].get<int>()>=2*geometry.value("composerLinePixels",0),"Both newly wrapped native lines fit completely");
    const auto last=SendMessageW(editor,EM_POSFROMCHAR,draft().size()-1,0);editBounds=geometry.at("composerBoundsPx");
    check(editBounds[0].get<int>()+static_cast<short>(LOWORD(last))<static_cast<int>(chatlayout::sendTargetLeft*dpi/96),"Last visible glyph stays to the left of Send");
    setDraft(L"One\r\nTwo\r\nThree\r\nFour\r\nFive\r\nSix 漢字 😀");geometry=state();
    check(geometry.value("composerLines",0)==6&&geometry.value("composerHeight",0.0f)==chatlayout::composerMaxHeight,"Explicit Unicode paragraphs cap the composer and retain native scrolling");
    SendMessageW(editor,EM_SETSEL,draft().size(),draft().size());SendMessageW(editor,EM_SCROLLCARET,0,0);
    const auto caret=SendMessageW(editor,EM_POSFROMCHAR,draft().size()-1,0);formatBounds=geometry.at("composerFormatPx");
    check(static_cast<short>(HIWORD(caret))>=formatBounds[1].get<int>()&&static_cast<short>(HIWORD(caret))+geometry.value("composerLinePixels",0)<=formatBounds[3].get<int>(),"The final line remains visible in the capped native editor");
    setDraft(L"Short");geometry=state();const float singleLine=std::max(chatlayout::composerMinHeight,geometry.value("composerLinePixels",0)*96.0f/dpi+2*chatlayout::composerPadding);
    check(std::abs(geometry.value("composerHeight",0.0f)-singleLine)<.1f,"Deleting multiline input immediately shrinks to one complete native line");
    SendMessageW(editor,EM_SETSEL,1,4);SendMessageW(panel,WM_DISPLAYCHANGE,0,0);DWORD selectionStart=0,selectionEnd=0;SendMessageW(editor,EM_GETSEL,reinterpret_cast<WPARAM>(&selectionStart),reinterpret_cast<LPARAM>(&selectionEnd));
    check(selectionStart==1&&selectionEnd==4&&draft()==L"Short","Display refresh preserves the native caret selection and draft");
    setDraft(L"");
    IAccessible* field=nullptr;check(SUCCEEDED(AccessibleObjectFromWindow(editor,OBJID_CLIENT,IID_IAccessible,reinterpret_cast<void**>(&field))),"Standard native Message field remains accessible");BSTR text=nullptr;field->get_accName(child(CHILDID_SELF),&text);check(text&&std::wstring(text)==L"Message","Native Message field has a meaningful accessible name");SysFreeString(text);field->Release();
    long send=named(L"Send message");VARIANT role{},disabled{};accessible->get_accRole(child(send),&role);accessible->get_accState(child(send),&disabled);
    check(role.vt==VT_I4&&role.lVal==ROLE_SYSTEM_PUSHBUTTON,"Send exposes a button role");check(disabled.vt==VT_I4&&(disabled.lVal&STATE_SYSTEM_UNAVAILABLE),"Empty Send is exposed as disabled");
    check(accessible->accDoDefaultAction(child(send))==S_FALSE,"Accessibility activation cannot bypass disabled Send");
    BSTR explanation=nullptr;accessible->get_accDescription(child(send),&explanation);check(explanation&&std::wstring(explanation).find(L"Write a message")!=std::wstring::npos,"Disabled Send explains what is missing");SysFreeString(explanation);
    setDraft(L"Keep this unsent draft");SendMessageW(search,WM_KEYDOWN,VK_ESCAPE,0);SendMessageW(panel,WM_KEYDOWN,VK_RETURN,0);Sleep(350);
    check(!std::filesystem::exists(fixture/L"sent.json")&&!std::filesystem::exists(fixture/L"assistant.json"),"Unfocused panel Enter cannot send a draft");check(draft()==L"Keep this unsent draft","Accidental Enter preserves the draft");
    select(named(L"Message options"));SendMessageW(panel,WM_KEYDOWN,VK_SPACE,0);wait([]{return SendMessageW(panel,WM_APP+211,static_cast<WPARAM>(AuditAction::Attach),0)!=0;},"Space activates the focused options button");SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);
    // Real IME messages must leave the final Enter with the input method.
    SendMessageW(editor,WM_IME_STARTCOMPOSITION,0,0);SendMessageW(editor,WM_KEYDOWN,VK_RETURN,1);SendMessageW(editor,WM_IME_ENDCOMPOSITION,0,0);Sleep(150);
    check(!std::filesystem::exists(fixture/L"assistant.json"),"Enter during IME composition cannot submit");setDraft(L"Keep this unsent draft");
    // Tab has a deterministic native-edit/search/custom-controls cycle.
    select(named(L"Message"));SendMessageW(editor,WM_KEYDOWN,VK_TAB,0);check(focus()==search,"Forward Tab moves Message to Search");SendMessageW(search,WM_KEYDOWN,VK_TAB,0);check(state().value("focused",-1)==0,"Next Tab focuses the first drawn control");
    SendMessageW(panel,WM_APP+218,2,0);check(focus()==search,"Reverse Tab from first canvas control returns to Search");SendMessageW(panel,WM_APP+218,2,0);check(focus()==editor,"Reverse Tab returns from Search to Message");
    SendMessageW(panel,WM_APP+218,1,0);check(focus()==search&&draft()==L"Keep this unsent draft","Ctrl+F focuses Search and preserves the draft");select(named(L"Message"));setDraft(L"Line one");const auto end=SendMessageW(editor,WM_GETTEXTLENGTH,0,0);SendMessageW(editor,EM_SETSEL,end,end);SendMessageW(panel,WM_APP+218,3,0);check(draft()==L"Line one\r\n","Shift+Enter inserts a real native newline without sending");setDraft(L"Keep this unsent draft");
    // Reorder and then remove a focused card without changing its child ID.
    const auto original=read(fixture/L"view.json");const auto cards=original.at("cards");check(cards.size()>2,"Reorder fixture has multiple chats");
    std::string firstName=cards[0].value("chatName","");long cardId=named(std::wstring(firstName.begin(),firstName.end()));select(cardId);
    auto reordered=cards;std::swap(reordered[0],reordered[1]);fault("patch",{{"cards",reordered}});
    wait([&]{auto s=state();for(const auto& h:s["hits"])if(h["action"]=="card")return h.value("key","").find(cards[1].value("id",""))!=std::string::npos;return false;},"Reordered cards reach the actual painted list");
    wait([&]{return name(cardId).find(std::wstring(firstName.begin(),firstName.end()))!=std::wstring::npos;},"Accessible card ID survives state reordering");
    VARIANT focused{};accessible->get_accFocus(&focused);check(focused.vt==VT_I4&&focused.lVal==cardId,"Keyboard focus follows the same card across repaint");
    auto reduced=reordered;reduced.erase(std::remove_if(reduced.begin(),reduced.end(),[&](const Json& c){return c.value("chatName","")==firstName;}),reduced.end());fault("patch",{{"cards",reduced}});
    wait([]{return state().value("focused",-1)==-1;},"Removing the focused card clears focus instead of retargeting it");SendMessageW(panel,WM_KEYDOWN,VK_RETURN,0);check(draft()==L"Keep this unsent draft","Removed-card Enter preserves the displayed draft");fault("reset");
    // No text was supplied by the user for an automatic update.
    fault("patch",{{"assistant",{{"messages",Json::array({{{"id","automatic-update"},{"kind","update"},{"text",""},{"answer","An automatic update with no empty user balloon."},{"status","complete"}}})},{"responding",false},{"error",""}}}});
    wait([]{return LOWORD(SendMessageW(panel,WM_APP+214,0,0))==1;},"Automatic update paints one meaningful balloon");saveCapture((L"ux-update-"+std::to_wstring(dpi)+L".png").c_str());
    // Long failure feedback occupies its own measured space above the transcript.
    const std::string failure="Conversation history is unavailable. Your saved message has been preserved. Reconnect before sending again. This intentionally long error verifies that the complete explanation wraps across several lines, reserves space above the composer, and remains available to Windows accessibility tools without overlapping the message bubbles or image previews.";
    fault("patch",{{"assistant",{{"messages",Json::array()},{"responding",false},{"error",failure}}}});
    wait([&]{return state().value("notice","")==failure;},"Full error text reaches the UI");auto errorState=state();check(errorState.value("noticeHeight",0)>36,"Long error receives a multiline status area");check(errorState.value("transcriptBottom",999)<598-errorState.value("noticeHeight",0),"Transcript yields space to feedback");
    check(name(named(L"Conversation history is unavailable"))==std::wstring(failure.begin(),failure.end()),"Full error is accessible without truncation");saveCapture((L"ux-error-"+std::to_wstring(dpi)+L".png").c_str());fault("reset");
    accessible->accDoDefaultAction(child(named(std::wstring(firstName.begin(),firstName.end()))));
    wait([]{return state().value("canDraft",false)&&LOWORD(SendMessageW(panel,WM_APP+214,0,0))>0;},"Source conversation is cached before disconnect");
    fault("disconnect");wait([]{return !state().value("connected",true);},"Dropped subscription enters offline state");
    check(LOWORD(SendMessageW(panel,WM_APP+214,0,0))>0,"Cached source transcript remains readable offline");
    check(IsWindowVisible(editor)&&state().value("canDraft",false)&&!state().value("canReply",true),"Offline composer remains editable while Send is disabled");setDraft(L"Offline saved draft 漢字");saveCapture((L"ux-offline-"+std::to_wstring(dpi)+L".png").c_str());
    fault("resume");wait([]{return state().value("connected",false);},"Subscription reconnects without restarting the app");check(draft()==L"Offline saved draft 漢字"&&state().value("canReply",false),"Identical state restores sending and keeps the draft");
    action(AuditAction::Assistant);setDraft(L"Describe this image");
    // Add through real WM_DROPFILES, avoiding global clipboard changes.
    const auto image=std::filesystem::canonical(fixture/L"fixture-image.png").wstring();drop({image});wait([]{auto s=state();return !s.value("canDraft",true)||s.value("hits",Json::array()).size()>0;},"Image drop is handled");
    wait([&]{try{return read(fixture/L"drafts.json").value("attachments",Json::object()).value("@hyphen",Json::array()).size()==1;}catch(...){return false;}},"Image import persists its draft");
    auto imageState=state();bool remove=false;for(const auto& h:imageState["hits"])if(h["action"]=="removeImage"){const auto b=h["box"];check(b[2].get<float>()-b[0].get<float>()>=44&&b[3].get<float>()-b[1].get<float>()>=44,"Image remove target meets 44 logical pixels");remove=true;}
    check(remove,"Image has a removable preview");saveCapture((L"ux-image-"+std::to_wstring(dpi)+L".png").c_str());
    setDraft(L"");action(AuditAction::DetailsMenu);const auto needs=named(L"What needs me?");accessible->accDoDefaultAction(child(needs));Sleep(300);check(state().value("notice","").find("Your draft is kept")!=std::string::npos,"Suggestion cannot consume an image-only draft");check(!std::filesystem::exists(fixture/L"assistant.json"),"Image draft suggestion never sends unexpectedly");
    accessible->accDoDefaultAction(child(named(L"Remove image")));wait([&]{try{return read(fixture/L"drafts.json")["attachments"]["@hyphen"].empty();}catch(...){return false;}},"Accessible image remove changes the saved draft");
    drop({image,image,image,image,image});wait([]{return state().value("notice","").find("four images")!=std::string::npos;},"Five-image drop gives a clear limit explanation");
    const auto invalid=fixture/L"invalid-image.png";{std::ofstream out(invalid);out<<"not a PNG";}drop({invalid.wstring()});wait([]{auto s=state();if(s.value("notice","").find("image")==std::string::npos)return false;for(const auto& h:s["hits"])if(h["action"]=="send")return !h.value("enabled",true);return false;},"Invalid image is rejected without creating a sendable draft");
    setDraft(L"Line one\r\nLine two 漢字 😀");RECT before{};GetWindowRect(editor,&before);SendMessageW(panel,WM_DISPLAYCHANGE,0,0);RECT after{};GetWindowRect(editor,&after);
    check(draft()==L"Line one\r\nLine two 漢字 😀"&&before.bottom-before.top==after.bottom-after.top,"Display refresh preserves multiline input and scaled geometry");
    action(AuditAction::FilterMenu);saveCapture((L"ux-menu-"+std::to_wstring(dpi)+L".png").c_str());SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);check(draft()==L"Line one\r\nLine two 漢字 😀","Menu cancellation preserves text");
    click(845,33);check(!IsWindowVisible(panel),"X immediately hides under reduced motion");
    accessible->Release();accessible=nullptr;PostMessageW(control,WM_CLOSE,0,0);check(WaitForSingleObject(process.hProcess,4000)==WAIT_OBJECT_0,"Reconnect worker cancels promptly on exit");DWORD code=1;GetExitCodeProcess(process.hProcess,&code);check(code==0,"Native UX session exits successfully");CloseHandle(process.hProcess);process.hProcess=nullptr;
    panel=control=editor=search=nullptr;command+=L" --assistant";process={};
    check(CreateProcessW(nullptr,command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&start,&process),"Restart only the isolated native app");CloseHandle(process.hThread);childPid=process.dwProcessId;
    wait([]{EnumWindows(find,0);return panel&&control;},"Locate the restarted audit window");editor=GetDlgItem(panel,201);search=GetDlgItem(panel,202);
    wait([]{return state().value("connected",false)&&IsWindowVisible(editor);},"Restarted app reconnects and exposes its saved composer");
    check(draft()==L"Line one\r\nLine two 漢字 😀","Actual app restart restores the durable Unicode multiline draft");
    PostMessageW(control,WM_CLOSE,0,0);check(WaitForSingleObject(process.hProcess,4000)==WAIT_OBJECT_0,"Restarted test app exits cleanly");GetExitCodeProcess(process.hProcess,&code);check(code==0,"Restarted native exit succeeds");CloseHandle(process.hProcess);process.hProcess=nullptr;
    std::cout<<"PASS "<<checks<<" native UX checks at "<<dpi<<" DPI (isolated rendering scale; simulated own-window input)\n";CoUninitialize();return 0;
}catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";if(accessible)accessible->Release();if(control)PostMessageW(control,WM_CLOSE,0,0);if(process.hProcess){if(WaitForSingleObject(process.hProcess,3000)!=WAIT_OBJECT_0)TerminateProcess(process.hProcess,2);CloseHandle(process.hProcess);}CoUninitialize();return 1;}}
