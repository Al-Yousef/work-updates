#include <algorithm>
#include <cassert>
#include <iostream>
#include "../src/queue-model.h"
int main(){
    QueueModel model;
    Json first={{"id","a"},{"taskKey","a1"},{"primarySourceId","chat-a"},{"kind","observed"},{"at",200},{"status","needs"},
        {"sources",Json::array({{{"id","chat-a"}},{{"id","chat-b"}}})}};
    Json second={{"id","b"},{"taskKey","b1"},{"kind","observed"},{"at",50},{"status","working"}};
    Json state={{"cards",Json::array({first,second})},{"done",Json::array()}, {"settings",{{"queueSince",100}}}};
    model.update(state);assert(model.cards().size()==1);model.browseAll=true;assert(model.cards().size()==2);
    assert(model.cards()[0]["id"]=="a");model.choose(first);assert(model.input()["sourceId"]=="chat-a");
    model.response({{"ok",true},{"command","details"},{"input",model.input()},
        {"value",{{"sources",Json::array({{{"id","chat-a"},{"body","correct"}},{{"id","chat-b"},{"body","other"}}})}}}});
    assert(model.body()=="correct");model.sourceId="chat-b";assert(model.body()=="other");
    model.response({{"ok",true},{"command","details"},{"input",{{"id","a"},{"taskKey","old"}}},{"value",{{"sources",Json::array()}}}});
    assert(model.body()=="other");
    state["cards"][0]["taskKey"]="a2";model.update(state);assert(model.selectedId=="a");assert(model.selectedKey=="a2");assert(model.sourceId=="chat-b");
    state["cards"][0]["reviewed"]=true;model.update(state);assert(model.cards().size()==1);
    model.view=2;assert(model.cards().size()==1);assert(model.cards()[0]["id"]=="a");
    state["cards"][0]["reviewed"]=false;state["cards"][0]["snoozed"]=true;model.update(state);assert(model.cards().size()==1);
    model.view=1;assert(model.cards().empty());state["cards"][1]["status"]="queued";model.update(state);assert(model.cards().size()==1);
    model.choose(second);model.pending=true;model.response({{"ok",false},{"error","stale task"}});
    assert(!model.pending);assert(model.message=="stale task");assert(model.selectedId=="b");
    state["cards"]=Json::array({first,second});model.update(state);
    model.choose(first);model.draft("Keep this reply");assert(model.canReply()&&model.hasDraft());
    auto submitted=model.replyInput();model.pending=true;model.pendingSend=submitted;
    assert(!model.canReply());
    model.response({{"ok",false},{"command","send"},{"input",submitted},{"error","active writer"}});
    assert(model.draft()=="Keep this reply");assert(model.pendingSend.empty());
    model.intentIds[model.sourceId]="stable-message";submitted=model.replyInput();
    model.response({{"ok",false},{"command","send"},{"input",submitted},{"delivery","uncertain"},{"error","Lost receipt"}});
    assert(model.replyInput()["messageId"]=="stable-message");
    model.sourceId="chat-b";model.draft("Different chat draft");model.back();model.choose(first);
    assert(model.draft()=="Keep this reply");
    model.response({{"ok",true},{"command","send"},{"input",submitted},{"value",Json::object()}});
    assert(model.draft()=="Keep this reply");assert(model.message.find("could not be confirmed")!=std::string::npos);
    model.draft("Edited after submission");
    model.response({{"ok",true},{"command","send"},{"input",submitted},{"value",{{"taskId","owned"}}}});
    assert(model.draft()=="Edited after submission");
    model.draft("Keep this reply");model.pending=true;model.pendingSend=submitted;
    auto adopted=first;adopted["id"]="owned";adopted["taskKey"]="owned";
    adopted["sources"]=Json::array({{{"id","chat-a"}}});state["cards"]=Json::array({adopted});
    model.update(state);assert(model.selectedId=="owned");assert(model.sourceId=="chat-a");
    model.response({{"ok",true},{"command","send"},{"input",submitted},{"value",{{"taskId","owned"}}}});
    assert(model.draft().empty());assert(model.message=="Sent to this chat.");
    assert(model.detailFollow&&model.detailOffset==1000000);
    assert(model.intentIds.empty());
    model.draft("Queue next reply");auto queued=model.replyInput();model.pending=true;model.pendingSend=queued;
    model.response({{"ok",true},{"command","queueMessage"},{"input",queued},{"value",{{"messageId","m1"},{"delivery","queued"}}}});
    assert(model.draft().empty());assert(model.message.find("Queued in Hyphen")!=std::string::npos);
    state["cards"][0]["queuedMessages"]=1;model.update(state);model.view=1;assert(model.cards().size()==1);
    model.sourceId="chat-b";assert(model.draft()=="Different chat draft");
    model.back();model.view=4;model.draft("Ask Hyphen");assert(model.composerKey()=="@hyphen");assert(model.canReply());
    model.intentIds["@hyphen"]="stable-ai-message";auto question=model.replyInput();assert(!question.contains("sourceId"));
    model.pendingSend=question;model.pending=true;
    model.response({{"command","assistantAsk"},{"input",question},{"ok",false},{"error","Connection lost"}});
    assert(model.draft()=="Ask Hyphen");assert(model.intentIds["@hyphen"]=="stable-ai-message");
    model.response({{"command","assistantAsk"},{"input",question},{"ok",true},{"value",{{"accepted",true},{"messageId","stable-ai-message"}}}});
    assert(model.draft().empty());assert(model.chatting());
    auto next=state;next["assistant"]={{"responding",true},{"messages",Json::array()}};model.update(next);assert(!model.canReply());
    next["assistant"]["responding"]=false;model.update(next);assert(model.canReply());
    model.response({{"command","assistantUse"},{"ok",true},{"value",{{"card",adopted},{"sourceId","chat-a"},{"draft","Review this proposed reply"}}}});
    assert(!model.chatting());assert(model.sourceId=="chat-a");assert(model.draft()=="Review this proposed reply");
    model.back();assert(model.chatting());assert(model.draft().empty());
    model.response({{"command","assistantUse"},{"ok",true},{"value",{{"card",adopted},{"sourceId","chat-a"},{"draft","Do not overwrite"}}}});
    assert(model.draft()=="Review this proposed reply");assert(model.message.find("existing")!=std::string::npos);
    model.back();model.view=4;model.draft("");
    Json image={{"id","image-one"},{"path","C:/private/one.png"}};
    model.response({{"command","attachImages"},{"ok",true},{"input",{{"composerKey","@hyphen"}}},{"value",{{"images",Json::array({image})}}}});
    assert(model.hasDraft());assert(model.replyInput()["attachmentIds"][0]=="image-one");
    model.intentIds["@hyphen"]="image-intent";auto imageQuestion=model.replyInput();
    model.removeImage("image-one");assert(!model.hasDraft());assert(!model.intentIds.contains("@hyphen"));
    model.response({{"command","attachImages"},{"ok",true},{"input",{{"composerKey","@hyphen"}}},{"value",{{"images",Json::array({image})}}}});
    model.attachments["@hyphen"].push_back({{"id","image-two"},{"path","C:/private/two.png"}});
    model.response({{"command","assistantAsk"},{"input",imageQuestion},{"ok",true},{"value",{{"accepted",true},{"messageId","image-intent"}}}});
    assert(model.images().size()==2); // A newer image draft must not be cleared by the old receipt.
    model.view=0;model.choose(adopted);assert(model.images().empty());model.back();model.view=4;assert(model.images().size()==2);
    QueueModel searched;auto named=first;named["chatName"]="Interface review";auto other=second;other["title"]="Review 漢字";
    searched.browseAll=true;searched.update({{"cards",Json::array({named,other})}});searched.choose(named);searched.draft("Keep this selected draft");
    searched.search="INTERFACE";assert(searched.cards().size()==1&&searched.cards()[0]["id"]=="a");assert(searched.sourceId=="chat-a"&&searched.draft()=="Keep this selected draft");
    searched.search="no match";assert(searched.cards().empty());assert(searched.canReply()&&searched.draft()=="Keep this selected draft");
    searched.search="漢字";assert(searched.cards().size()==1&&searched.cards()[0]["id"]=="b");searched.search.clear();assert(searched.cards().size()==2);
    QueueModel reading;reading.view=4;reading.update({{"assistant",{{"messages",Json::array()}}}});reading.assistantOffset=72;reading.assistantFollow=false;
    reading.update({{"assistant",{{"messages",Json::array({{{"text","New answer"}}})}}}});assert(reading.assistantOffset==72);
    reading.assistantFollow=true;reading.update({{"assistant",{{"messages",Json::array({{{"text","Another answer"}}})}}}});assert(reading.assistantOffset==1000000);
    searched.connected=false;assert(searched.canDraft()&&!searched.canReply());searched.draft("Offline draft survives");assert(searched.draft()=="Offline draft survives");
    searched.update(searched.state);assert(searched.canReply()&&searched.draft()=="Offline draft survives");
    searched.pending=true;assert(searched.canDraft()&&!searched.canReply());searched.pending=false;
    // Independent read generations never release the writer or consume drafts.
    QueueModel responsive;responsive.update({{"cards",Json::array({first,adopted})}});responsive.choose(first);
    responsive.draft("Saved first draft");auto oldRead=responsive.beginDetails(100);responsive.pending=true;responsive.pendingOwner="chat-a";
    responsive.choose(adopted);auto newRead=responsive.beginDetails(200);
    responsive.response({{"command","details"},{"ok",false},{"input",oldRead},{"error","Superseded"}});
    assert(responsive.detailPending&&responsive.detailError.empty()&&responsive.pending&&responsive.draft()=="Saved first draft");
    responsive.response({{"command","details"},{"ok",true},{"input",newRead},{"value",adopted}});
    assert(!responsive.detailPending&&responsive.pending&&responsive.canDraft()&&!responsive.canReply());
    responsive.detailOffset=7;responsive.detailFollow=false;responsive.choose(first);responsive.choose(adopted);
    assert(responsive.detail==adopted&&responsive.detailOffset==7&&!responsive.detailFollow);
    responsive.sourceId="chat-b";responsive.draft("Other chat draft");auto reply=Json({{"sourceId","chat-a"},{"text","Old submitted text"},{"attachmentIds",Json::array()}});
    responsive.response({{"command","send"},{"ok",true},{"input",reply},{"value",{{"taskId","owned"}}}});
    assert(responsive.draft()=="Other chat draft"&&responsive.message.empty()&&responsive.notices["chat-a"]=="Sent to this chat. Your newer draft is kept.");
    for(int i=0;i<30;++i){auto c=first;c["id"]=std::to_string(i);responsive.state["cards"].push_back(c);responsive.choose(c);responsive.detail=c;responsive.remember();}
    assert(responsive.recent.size()==12);
    QueueModel changedSource;changedSource.update({{"cards",Json::array({first})}});changedSource.choose(first);changedSource.draft("Previous source draft");
    auto sourceChanged=first;sourceChanged["sources"]=Json::array({{{"id","chat-b"}}});changedSource.update({{"cards",Json::array({sourceChanged})}});
    assert(changedSource.sourceId=="chat-b"&&changedSource.drafts["chat-a"]=="Previous source draft");
    QueueModel delayedLink;delayedLink.update({{"cards",Json::array({first})}});delayedLink.choose(first);delayedLink.sourceId="chat-b";delayedLink.draft("Keep this other draft");delayedLink.pending=true;delayedLink.pendingOwner="@hyphen";
    delayedLink.response({{"command","assistantUse"},{"ok",true},{"value",{{"card",first},{"sourceId","chat-a"},{"draft","Ready in the original chat"}}}});
    assert(delayedLink.sourceId=="chat-b"&&delayedLink.draft()=="Keep this other draft"&&delayedLink.drafts["chat-a"]=="Ready in the original chat"&&delayedLink.message.empty());
    QueueModel lateReceipt;lateReceipt.update({{"cards",Json::array({first})}});lateReceipt.choose(first);lateReceipt.draft("Submitted reply");auto submittedReply=lateReceipt.replyInput();lateReceipt.draft("New draft");lateReceipt.detailFollow=false;lateReceipt.detailOffset=5;
    lateReceipt.response({{"command","send"},{"input",submittedReply},{"ok",true},{"value",{{"taskId","owned"}}}});
    assert(!lateReceipt.detailFollow&&lateReceipt.detailOffset==5&&lateReceipt.draft()=="New draft"&&lateReceipt.message.find("newer draft is kept")!=std::string::npos);
    std::cout<<"Native queue and assistant model: identity, draft isolation, search, images, stale responses, offline drafts, filters and receipt checks passed\n";
}
