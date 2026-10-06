#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <chrono>
#include <stdexcept>
#include "../vendor/nlohmann/json.hpp"
using Json=nlohmann::json;
namespace {
DWORD pid=0;HWND panel=nullptr,control=nullptr,editor=nullptr,search=nullptr;
std::filesystem::path artifacts,fixture;bool baseline=false;unsigned requestId=0;
BOOL CALLBACK find(HWND h,LPARAM){DWORD p=0;GetWindowThreadProcessId(h,&p);if(p!=pid)return TRUE;wchar_t name[80]{};GetClassNameW(h,name,80);if(!wcscmp(name,L"NativeHoverPanel"))panel=h;if(!wcscmp(name,L"NativeHoverTrigger"))control=h;return TRUE;}
Json read(const std::filesystem::path& p){std::ifstream f(p);return Json::parse(f);}
Json state(){SendMessageW(panel,WM_APP+215,0,0);return read(artifacts/L"ux-state.json");}
void wait(auto f,const char* error){for(int i=0;i<240;++i){if(f())return;Sleep(25);}throw std::runtime_error(error);}
void check(bool okay,const char* message){if(!okay)throw std::runtime_error(message);}
double click(const Json& requested){
 auto t=std::chrono::steady_clock::now();
 for(int attempt=0;attempt<3;++attempt){
  auto h=requested;
  if(h.value("action","")=="card"){
   const auto liveState=state();bool present=false;for(const auto& live:liveState["hits"])if(live.value("key","")==h.value("key","")){h=live;present=true;break;}
   check(present,"Requested chat disappeared before its test click");
  }
  auto b=h.at("box");const int x=static_cast<int>((b[0].get<float>()+b[2].get<float>())/2),y=static_cast<int>((b[1].get<float>()+b[3].get<float>())/2);auto point=MAKELPARAM(x,y);
  SendMessageW(panel,WM_LBUTTONDOWN,MK_LBUTTON,point);
  if(h.value("action","")=="card"){
   // The backend may reorder rows between the snapshot and mouse-down. Cancel
   // before release rather than accidentally testing another chat's draft.
   const auto liveState=state();bool same=false;for(const auto& live:liveState["hits"]){auto box=live.at("box");if(x>=box[0].get<float>()&&x<=box[2].get<float>()&&y>=box[1].get<float>()&&y<=box[3].get<float>())same=live.value("key","")==h.value("key","");}
   if(!same){SendMessageW(panel,WM_CANCELMODE,0,0);continue;}
  }
  SendMessageW(panel,WM_LBUTTONUP,0,point);
  if(h.value("action","")!="card"||state().value("source","")==h.value("sourceId",""))return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count();
 }
 throw std::runtime_error("Chat rows did not stabilize for the identity-checked test click");
}
std::vector<Json> cards(){std::vector<Json> out;auto s=state();for(auto& h:s["hits"])if(h["action"]=="card")out.push_back(h);return out;}
Json action(const char* a){auto s=state();for(auto& h:s["hits"])if(h["action"]==a&&h.value("enabled",true))return h;throw std::runtime_error(a);}
Json source(const std::string& id){for(const auto& h:cards())if(h.value("sourceId","")==id)return h;throw std::runtime_error("Source card absent");}
void fault(const char* op,Json value=Json::object()){const auto id=std::to_string(++requestId);{std::ofstream f(fixture/L"ux-command.json");f<<Json({{"id",id},{"op",op},{"value",value}}).dump();}wait([&]{try{return read(fixture/L"ux-result.json").value("id","")==id;}catch(...){return false;}},"Fixture fault was not acknowledged");}
double timed(auto f){auto t=std::chrono::steady_clock::now();f();return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count();}
void draft(const wchar_t* text){SendMessageW(editor,WM_SETTEXT,0,reinterpret_cast<LPARAM>(text));}
std::wstring text(){std::wstring t(12002,0);t.resize(SendMessageW(editor,WM_GETTEXT,t.size(),reinterpret_cast<LPARAM>(t.data())));return t;}
}
int wmain(int argc,wchar_t** argv){PROCESS_INFORMATION child{};Json result;
try{
 check(argc==3,"descriptor plus baseline/final required");baseline=!wcscmp(argv[2],L"baseline");
 fixture=std::filesystem::path(argv[1]).parent_path();
 wchar_t own[32768]{};GetModuleFileNameW(nullptr,own,32768);auto dir=std::filesystem::path(own).parent_path();artifacts=dir/L"artifacts";
 std::wstring cmd=L"\""+(dir/L"Native Hover.exe").wstring()+L"\" --isolated-session --no-auto-attach --show --audit-reduced-motion --audit-thumbnail-delay-ms 1200 --audit-capture \""+(artifacts/L"responsiveness.png").wstring()+L"\" --bridge \""+argv[1]+L"\"";
 STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
 check(CreateProcessW(nullptr,cmd.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child),"Start isolated native responsiveness child");CloseHandle(child.hThread);pid=child.dwProcessId;
 wait([]{EnumWindows(find,0);return panel&&control;},"Own test windows absent");editor=GetDlgItem(panel,201);search=GetDlgItem(panel,202);wait([]{return state().value("connected",false);},"fixture did not connect");
 auto first=cards();check(first.size()>=2,"Two visible chats required");
 auto start=std::chrono::steady_clock::now();result["cold_click_handler_ms"]=click(first[0]);result["draft_editable_during_load"]=state().value("canDraft",false);const auto firstSource=state().value("source","");
 if(!baseline){check(result["draft_editable_during_load"],"Loading a chat blocks typing");check(state().value("detailPending",false),"Slow detail request did not start");draft(L"First chat saved draft");}
 result["second_click_handler_ms"]=click(cards()[1]);result["second_chat_enabled_during_load"]=cards()[1].value("enabled",true);const auto secondSource=state().value("source","");
 if(!baseline){auto s=state();check(first[1].value("key","").find("\n"+s.value("selected","")+"\n")!=std::string::npos,"Second click did not select the requested chat");draft(L"Second chat saved draft");SendMessageW(panel,WM_APP+218,1,0);}
 wait([]{auto s=state();return s.value("canDraft",false)&&!s.value("detailPending",false);},"Details never completed");result["details_completed_after_ms"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
 if(!baseline){check(text()==L"Second chat saved draft","Stale details replaced the current draft");GUITHREADINFO i{};i.cbSize=sizeof(i);GetGUIThreadInfo(GetWindowThreadProcessId(panel,nullptr),&i);check(i.hwndFocus==search,"Details stole focus from Search");check(state().value("detailMatchesSelection",false),"Latest details do not match selected chat");
 result["cached_click_handler_ms"]=click(cards()[1]);check(LOWORD(SendMessageW(panel,WM_APP+214,0,0))>0,"Recent chat did not show its cached messages immediately");check(text()==L"Second chat saved draft","Reopening a chat lost its draft");
 click(source(firstSource));draft(L"Harmless isolated send");result["send_click_handler_ms"]=click(action("send"));check(state().value("pending",false),"Delayed send did not start");draft(L"Newer draft while sending");result["navigation_during_send_ms"]=click(source(secondSource));check(text()==L"Second chat saved draft","Sending prevented navigation to saved draft");check(state().value("notice","").find("Sending…")==std::string::npos,"Other chat shows an unrelated sending receipt");
 draft(L"Edited second chat during send");wait([]{return !state().value("pending",true);},"Send did not finish");check(text()==L"Edited second chat during send","Receipt replaced another chat's draft");check(state().value("notice","").find("Sent to this chat") == std::string::npos,"Receipt appeared in the wrong chat");click(source(firstSource));check(text()==L"Newer draft while sending","Receipt cleared text written after submission");
 result["last_paint_ms"]=state().value("paintMs",0.0);result["layout_cache_entries"]=state().value("bubbleLayouts",0);result["latest_selection_and_drafts_verified"]=true;
 // Loading failure retries only the read, while preserving the selected draft.
 wait([]{return !state().value("detailPending",true);},"Read after adoption did not finish");fault("fail-details");click(source("10000000-0000-4000-8000-000000000002"));draft(L"Keep this draft through a history error");
 wait([]{return state().value("notice","").find("could not load")!=std::string::npos;},"Read error has no feedback");click(action("retryDetails"));wait([]{return !state().value("detailPending",true);},"Read retry did not finish");check(text()==L"Keep this draft through a history error","Read retry erased text");check(read(fixture/L"sent.json").size()==1,"Read retry sent another message");result["read_retry_preserves_draft_and_does_not_send"]=true;
 // A real 4096px image is delayed on its worker, never on the UI thread.
 click(action("assistant"));const auto imagePath=(fixture/L"large-preview.png").generic_string();fault("patch",{{"assistant",{{"messages",Json::array({{{"id","large-image"},{"text",""},{"answer","A large image preview should not pause the chat controls."},{"images",Json::array({{{"id","large-preview"},{"path",imagePath},{"name","Large preview"}}})},{"status","complete"}}})},{"responding",false},{"error",""}}}});
 wait([]{return state().value("loadingImages",0)>0;},"Image was not queued on the worker");
 result["typing_during_image_decode_ms"]=timed([]{draft(L"Write while the image loads");});check(text()==L"Write while the image loads","Image loading blocks typing");
 result["search_during_image_decode_ms"]=timed([]{SendMessageW(search,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L"Interface"));});check(text()==L"Write while the image loads","Search replaced the displayed draft");
 SendMessageW(search,WM_SETTEXT,0,reinterpret_cast<LPARAM>(L""));result["menu_open_during_image_decode_ms"]=click(action("filterMenu"));result["menu_dismiss_ms"]=timed([]{SendMessageW(panel,WM_KEYDOWN,VK_ESCAPE,0);});
 wait([]{return state().value("imageBitmaps",0)>0&&state().value("loadingImages",1)==0;},"Thumbnail never completed");result["image_worker_verified"]=true;
 SendMessageW(panel,WM_APP+210,0,0);std::filesystem::copy_file(artifacts/L"responsiveness.png",artifacts/L"responsiveness-image.png",std::filesystem::copy_options::overwrite_existing);fault("reset");
 // Delayed import also allows a different chat and its draft to remain usable.
 {std::ofstream f(fixture/L"ux-drop.json");f<<Json::array({(fixture/L"fixture-image.png").generic_string()}).dump();}check(SendMessageW(panel,WM_APP+219,0,0)==1,"Image import input absent");check(state().value("pending",false),"Import delay not exercised");click(source(secondSource));draft(L"Keep writing while an image imports elsewhere");
 wait([]{return !state().value("pending",true);},"Image import did not finish");check(text()==L"Keep writing while an image imports elsewhere","Image import stole the draft");click(action("assistant"));check(text()==L"Write while the image loads","Import lost its own destination draft");result["image_import_and_navigation_verified"]=true;
 // Preserve the reading bookmark, including incoming updates while scrolled up.
 fault("patch",{{"assistant",{{"messages",Json::array()},{"responding",false},{"error",""}}}});click(source(firstSource));wait([]{return !state().value("detailPending",true);},"Bookmark chat did not load");POINT scrollPoint{600,260};ClientToScreen(panel,&scrollPoint);SendMessageW(panel,WM_MOUSEWHEEL,MAKEWPARAM(0,120),MAKELPARAM(scrollPoint.x,scrollPoint.y));const auto bookmark=state();check(bookmark.value("detailOffset",0)>0&&!bookmark.value("detailFollow",true),"Fixture does not exercise a nonzero reading bookmark");click(source(secondSource));click(source(firstSource));check(state()["detailOffset"]==bookmark["detailOffset"]&&state()["detailFollow"]==bookmark["detailFollow"],"Returning to a chat lost the reading bookmark");result["reading_bookmark_verified"]=true;
 for(const auto& key:{"cold_click_handler_ms","second_click_handler_ms","cached_click_handler_ms","send_click_handler_ms","navigation_during_send_ms","typing_during_image_decode_ms","search_during_image_decode_ms","menu_open_during_image_decode_ms","menu_dismiss_ms"})check(result[key].get<double>()<250,"Local interaction stalled for more than 250ms");
 }
 SendMessageW(panel,WM_APP+210,0,0);PostMessageW(control,WM_CLOSE,0,0);check(WaitForSingleObject(child.hProcess,4000)==WAIT_OBJECT_0,"Own child did not cancel background reads on close");CloseHandle(child.hProcess);child.hProcess=nullptr;
 result["mode"]=baseline?"baseline":"final";result["details_fixture_delay_ms"]=1500;result["send_fixture_delay_ms"]=2000;result["scope"]="Own Win32 handlers and painted state; synthetic backend, no Explorer injection or signed-in messages";
 {std::ofstream f(artifacts/(baseline?L"responsiveness-baseline.json":L"responsiveness-final.json"));f<<result.dump(2);}std::cout<<result.dump(2)<<"\n";return 0;
}catch(const std::exception& e){std::cerr<<"FAIL "<<e.what()<<"\n";if(control)PostMessageW(control,WM_CLOSE,0,0);if(child.hProcess){if(WaitForSingleObject(child.hProcess,4000)!=WAIT_OBJECT_0)TerminateProcess(child.hProcess,2);CloseHandle(child.hProcess);}return 1;}}
