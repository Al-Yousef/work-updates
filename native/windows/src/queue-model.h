#pragma once
#include "../vendor/nlohmann/json.hpp"
#include <string>
#include <vector>
#include <algorithm>
#include <map>
#include <cctype>
#include "chat-layout.h"
using Json = nlohmann::json;
// Collector freshness metadata is retained, but is not drawn by the native UI.
// Every other field, including unknown additions, conservatively invalidates it.
inline bool sameRenderedState(const Json& before,const Json& after) {
    if(!before.is_object()||!after.is_object())return before==after;
    for(const auto& [key,value]:before.items())
        if(key!="connectionHealth"&&(!after.contains(key)||after.at(key)!=value))return false;
    for(const auto& [key,value]:after.items())
        if(key!="connectionHealth"&&!before.contains(key))return false;
    return true;
}
struct QueueModel {
    Json state=Json::object(), detail=Json::object();
    std::string selectedId,selectedKey,sourceId,message,search,pendingCommand;
    std::map<std::string,std::string> drafts;
    std::map<std::string,std::string> intentIds;
    std::map<std::string,Json> attachments;
    Json pendingSend=Json::object();
    struct Recent {Json detail;std::string source;int offset=0;bool follow=true;uint64_t used=0;};
    std::map<std::string,Recent> recent;
    std::map<std::string,std::string> notices;
    std::string pendingOwner,detailError;
    uint64_t detailRequest=0,recentClock=0,detailStarted=0;
    bool detailPending=false;
    bool connected=false,pending=false,browseAll=false,detailFollow=true,assistantFollow=true;
    int view=0,offset=0,detailOffset=0,assistantOffset=1000000;
    bool chatting() const {return view==4&&selectedId.empty();}
    std::string composerKey() const {return chatting()?"@hyphen":sourceId;}
    std::vector<Json> cards() const {
        std::vector<Json> result;
        const int listView=view==4?0:view;
        const char* key=listView==3?"done":"cards";
        if(!state.contains(key) || !state[key].is_array())return result;
        for(const auto& card:state[key]) {
            if(listView!=3) {
                if(card.value("done",false))continue;
                bool hidden=card.value("reviewed",false)||card.value("snoozed",false);
                if(hidden!=(listView==2) && !(listView==1 && card.value("queuedMessages",0)>0))continue;
                if(listView!=2 && (listView==1 ? (card.value("status","")!="queued" && card.value("queuedMessages",0)==0) : card.value("status","")=="queued"))continue;
                if(listView==0 && !browseAll && card.value("kind","")!="local" &&
                    card.value("at",0LL)<state.value("settings",Json::object()).value("queueSince",0LL))continue;
            }
            if(!search.empty()) {
                auto lower=[](std::string value){for(char& c:value)if(static_cast<unsigned char>(c)<128)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));return value;};
                const auto content=card.value("chatName","")+"\n"+card.value("title","")+"\n"+card.value("summary","")+"\n"+card.value("label","");
                if(lower(content).find(lower(search))==std::string::npos)continue;
            }
            result.push_back(card);
        }
        return result;
    }
    Json selected() const {
        for(const char* key:{"cards","done"})if(state.contains(key)&&state[key].is_array())
            for(const auto& card:state[key])if(card.value("id","")==selectedId &&
                card.value("taskKey","")==selectedKey)return card;
        return Json::object();
    }
    std::string recentKey() const {return selectedId+"\n"+selectedKey;}
    void remember() {
        if(selectedId.empty()||detail.empty())return;
        recent[recentKey()]={detail,sourceId,detailOffset,detailFollow,++recentClock};
        while(recent.size()>12){auto oldest=std::min_element(recent.begin(),recent.end(),[](const auto& a,const auto& b){return a.second.used<b.second.used;});recent.erase(oldest);}
    }
    void back(){remember();selectedId.clear();selectedKey.clear();sourceId.clear();detail=Json::object();detailOffset=0;detailPending=false;detailError.clear();++detailRequest;}
    void update(Json value) {
        auto before=state.value("assistant",Json::object()).value("messages",Json::array());
        auto after=value.value("assistant",Json::object()).value("messages",Json::array());
        if(before!=after&&assistantFollow)assistantOffset=1000000;
        state=std::move(value);connected=true;
        if(!selectedId.empty() && selected().empty()) {
            // Adopting an observed chat creates a local task with a new card ID.
            // Keep the same source selected while its submitted reply completes.
            bool followed=false;
            if(!sourceId.empty()) {
                for(const auto& card:state.value("cards",Json::array())) {
                    auto sources=card.value("sources",Json::array());
                    bool contains=std::any_of(sources.begin(),sources.end(),[&](const Json& s){return s.value("id","")==sourceId;});
                    if(contains && (card.value("id","")==selectedId || !pendingSend.empty())) {
                        selectedId=card.value("id","");selectedKey=card.value("taskKey","");
                        detail=Json::object();detailPending=false;detailError.clear();++detailRequest;followed=true;break;
                    }
                }
            }
            if(!followed){back();message="This task changed. Choose its latest update.";}
        }
        if(!selectedId.empty()&&currentSource().empty()) {
            const auto sources=selected().value("sources",Json::array());
            sourceId=sources.empty()?"":sources[0].value("id","");detail=Json::object();detailPending=false;detailError.clear();++detailRequest;
            message="This chat's source changed. Your previous draft is saved.";
        }
        const auto count=static_cast<int>(cards().size());offset=std::clamp(offset,0,std::max(0,count-chatlayout::visibleRows));
    }
    void choose(const Json& card) {
        remember();
        selectedId=card.value("id","");selectedKey=card.value("taskKey","");
        sourceId=card.value("primarySourceId","");detail=Json::object();detailOffset=0;detailFollow=true;message.clear();detailPending=false;detailError.clear();++detailRequest;
        auto found=recent.find(recentKey());if(found!=recent.end()) {
            detail=found->second.detail;found->second.used=++recentClock;
            if(sourceId==found->second.source){detailOffset=found->second.offset;detailFollow=found->second.follow;}
        }
        if(notices.contains(composerKey()))message=notices[composerKey()];
    }
    bool detailNeeded() const {
        if(selectedId.empty())return false;if(detail.empty())return true;
        const auto source=currentSource();
        for(const auto& cached:detail.value("sources",Json::array()))if(cached.value("id","")==sourceId)
            return cached.value("contextLoaded",false)!=source.value("contextLoaded",false)||cached.value("conversationLoaded",false)!=source.value("conversationLoaded",false)||
                cached.value("contextRevision","")!=source.value("contextRevision","")||cached.value("queuedMessages",0)!=source.value("queuedMessages",0)||cached.value("deliveryIssue","")!=source.value("deliveryIssue","");
        return true;
    }
    Json beginDetails(uint64_t now){detailPending=true;detailError.clear();detailStarted=now;auto value=input();value["detailRequest"]=++detailRequest;return value;}
    Json input() const {return {{"id",selectedId},{"taskKey",selectedKey},{"sourceId",sourceId}};}
    std::string draft() const {auto found=drafts.find(composerKey());return found==drafts.end()?"":found->second;}
    std::string pendingDestination() const {if(pendingOwner=="@hyphen")return "Hyphen";for(const char* key:{"cards","done"})for(const auto& card:state.value(key,Json::array()))for(const auto& source:card.value("sources",Json::array()))if(source.value("id","")==pendingOwner)return card.value("chatName",std::string("another chat"));return "another chat";}
    void draft(std::string value) {auto key=composerKey();if(!key.empty()){if(value!=draft())intentIds.erase(key);drafts[key]=std::move(value);}}
    bool sourceAvailable() const {const auto card=selected();const auto availability=card.value("availability",Json::object()).value("state","");return card.value("owner",Json::object()).value("online",true)&&availability!="offline"&&availability!="stale";}
    bool canReply() const {if(chatting()){auto ai=state.value("assistant",Json::object());return connected&&!pending&&!ai.value("responding",false)&&ai.value("error","").empty();}auto card=selected();return connected&&!pending&&!sourceId.empty()&&!card.empty()&&!card.value("done",false)&&sourceAvailable();}
    bool canDraft() const {return chatting()||(!sourceId.empty()&&!selected().empty()&&!selected().value("done",false));}
    Json images() const {auto it=attachments.find(composerKey());return it==attachments.end()?Json::array():it->second;}
    Json imageIds(const std::string& key) const {Json ids=Json::array();auto it=attachments.find(key);if(it!=attachments.end())for(const auto& image:it->second)ids.push_back(image.value("id",""));return ids;}
    void removeImage(const std::string& id) {auto key=composerKey();auto& images=attachments[key];images.erase(std::remove_if(images.begin(),images.end(),[&](const Json& image){return image.value("id","")==id;}),images.end());intentIds.erase(key);}
    bool defaultQueue() const {auto lifecycle=currentSource().value("lifecycle","");return !chatting()&&sourceAvailable()&&(lifecycle=="working"||lifecycle=="starting");}
    Json replyInput() const {auto value=chatting()?Json::object():input();value["text"]=draft();value["attachmentIds"]=imageIds(composerKey());auto id=intentIds.find(composerKey());if(id!=intentIds.end())value["messageId"]=id->second;return value;}
    bool hasDraft() const {auto value=draft();return !images().empty()||std::any_of(value.begin(),value.end(),[](unsigned char c){return !std::isspace(c);});}
    void acceptedDraft(const std::string& key,const Json& input) {if(drafts[key]==input.value("text","")&&imageIds(key)==input.value("attachmentIds",Json::array())){drafts.erase(key);attachments.erase(key);intentIds.erase(key);}}
    void response(const Json& result) {
        const auto command=result.value("command","");const auto input=result.value("input",Json::object());
        if(command=="details") {
            if(input.value("id","")!=selectedId||input.value("taskKey","")!=selectedKey||
                (input.contains("detailRequest")&&(input.value("detailRequest",0ULL)!=detailRequest||input.value("sourceId","")!=sourceId)))return;
            detailPending=false;
            if(!result.value("ok",false)){detailError="Messages could not load. Your draft is saved.";return;}
            detail=result.value("value",Json::object());detailError.clear();remember();return;
        }
        const auto owner=command=="assistantAsk"?"@hyphen":command=="assistantUse"?result.value("value",Json::object()).value("sourceId",pendingOwner):input.value("composerKey",input.value("sourceId",pendingOwner));
        const auto before=message;commandResponse(result);
        if(!owner.empty())notices[owner]=message;
        if(!owner.empty()&&owner!=composerKey())message=before;
        pendingOwner.clear();
    }
    void commandResponse(const Json& result) {
        pending=false;pendingCommand.clear();
        std::string command=result.value("command","");
        if(command=="attachImages") {
            if(!result.value("ok",false)){message=result.value("error","Image could not be attached.");return;}
            auto key=result.value("input",Json::object()).value("composerKey","");if(key.empty())return;
            auto& current=attachments[key];if(!current.is_array())current=Json::array();
            for(const auto& image:result.value("value",Json::object()).value("images",Json::array())) {
                if(std::none_of(current.begin(),current.end(),[&](const Json& old){return old.value("id","")==image.value("id","");})) {
                    if(current.size()>=4){message="Up to four images per message.";break;}current.push_back(image);intentIds.erase(key);
                }
            }return;
        }
        if(command=="assistantAsk") {
            const auto input=result.value("input",pendingSend);pendingSend=Json::object();
            if(!result.value("ok",false)){message=result.value("error","Hyphen could not accept this message. Your draft is saved.");return;}
            const auto receipt=result.value("value",Json::object());
            if(!receipt.value("accepted",false)||receipt.value("messageId","")!=input.value("messageId","")){message="Receipt unavailable. Retry this saved message to check it.";return;}
            acceptedDraft("@hyphen",input);
            message.clear();if(assistantFollow)assistantOffset=1000000;return;
        }
        if(command=="assistantUse") {
            if(!result.value("ok",false)){message=result.value("error","This update is unavailable.");return;}
            const auto value=result.value("value",Json::object());const auto card=value.value("card",Json::object());
            if(!pendingOwner.empty()&&pendingOwner!=composerKey()) {
                const auto target=value.value("sourceId","");const auto proposed=value.value("draft","");
                if(!target.empty()&&drafts[target].empty()&&!proposed.empty()){drafts[target]=proposed;message="Hyphen’s draft is ready. Review it before sending.";}
                else message="Your existing draft is kept.";
                return;
            }
            choose(card);sourceId=value.value("sourceId","");detail=card;
            if(selected().empty()){back();message="This update is outside the current queue view.";return;}
            const auto proposed=value.value("draft","");
            if(!proposed.empty()) {
                if(draft().empty()){draft(proposed);message="Draft ready. Review it, then choose Send or Queue.";}
                else message="Your existing chat draft is kept. Hyphen’s draft has not replaced it.";
            }
            return;
        }
        if(command=="send" || command=="queueMessage") {
            auto input=result.value("input",pendingSend);pendingSend=Json::object();
            if(!result.value("ok",false)) {
                if(result.value("delivery","")!="uncertain")intentIds.erase(input.value("sourceId",""));
                message=result.value("error","Message was not sent. Your draft is saved.");
                if(!result.value("recovery","").empty())message=result.value("recovery","");
                if(message.find("active writer")!=std::string::npos)
                    message="Codex has this chat open. Reply there for now. Your draft is saved.";
                return;
            }
            const auto receipt=result.value("value",Json::object());
            if(receipt.value("messageId","").empty() && receipt.value("taskId","").empty()) {message="Delivery could not be confirmed. Open chat to check before sending again.";return;}
            const auto key=input.value("sourceId","");acceptedDraft(key,input);
            if(key==sourceId&&detailFollow)detailOffset=1000000;
            message=receipt.value("delivery","")=="queued"?"Queued in Hyphen. Sends after this pass finishes.":"Sent to this chat.";
            if((drafts.contains(key)&&!drafts[key].empty())||!imageIds(key).empty())message+=" Your newer draft is kept.";return;
        }
        if(!result.value("ok",false)){message=result.value("error","Action failed.");return;}
        if(command=="action") {const auto input=result.value("input",Json::object());if(input.value("id",selectedId)==selectedId&&input.value("taskKey",selectedKey)==selectedKey)back();message="Updated. Use Undo to reverse this action.";}
        else if(command=="undo")message="Restored.";
        else if(command=="open")message="Opening this chat in Codex.";
        else if(command=="clearMessages")message="Message queue updated.";
    }
    std::string body() const {
        if(detail.contains("sources"))for(const auto& source:detail["sources"])
            if(source.value("id","")==sourceId)
            {
                auto value=source.value("body","");
                for(const auto& m:source.value("messageQueue",Json::array()))
                    value+="\n\nHyphen message · "+m.value("status","")+"\n"+m.value("text","")+(m.value("error","").empty()?"":"\n"+m.value("error",""));
                return value;
            }
        return "";
    }
    Json currentSource() const {auto card=selected();for(const auto& source:card.value("sources",Json::array()))if(source.value("id","")==sourceId)return source;return Json::object();}
    Json conversation() const {
      for(const auto& source:detail.value("sources",Json::array())) {if(source.value("id","")==sourceId) {
        auto messages=source.value("conversation",Json::array());if(messages.empty()&&!source.value("body","").empty())messages.push_back({{"role","assistant"},{"text",source.value("body","")},{"images",Json::array()}});
        for(const auto& item:source.value("messageQueue",Json::array()))messages.push_back({{"role","user"},{"text",item.value("text","")+"\n"+item.value("status","")},{"images",Json::array()}});return messages;
      }}return Json::array();
    }
};
