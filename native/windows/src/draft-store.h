#pragma once
#include <stdexcept>
#include "../vendor/nlohmann/json.hpp"
namespace draft_store {
using Json=nlohmann::json;
inline Json validate(Json data) {
    if(!data.is_object())throw std::runtime_error("Invalid saved drafts");
    if(!data.contains("version"))data=Json{{"version",3},{"drafts",data},{"intentIds",Json::object()},{"attachments",Json::object()}};
    if(!data["version"].is_number_integer()||data["version"].get<int>()<1||data["version"].get<int>()>3||!data.contains("drafts")||!data["drafts"].is_object())throw std::runtime_error("Unsupported saved draft version");
    if(!data.contains("intentIds"))data["intentIds"]=Json::object();
    if(!data.contains("attachments"))data["attachments"]=Json::object();
    if(!data.contains("replyTargets"))data["replyTargets"]=Json::object();
    if(!data["replyTargets"].is_object()||data["replyTargets"].size()>1)throw std::runtime_error("Invalid saved reply target");
    for(auto it=data["replyTargets"].begin();it!=data["replyTargets"].end();++it)
        if(it.key()!="@hyphen"||!it.value().is_object()||!it.value().contains("id")||!it.value()["id"].is_string()||it.value()["id"].get<std::string>().empty()||it.value()["id"].get<std::string>().size()>100||
            !it.value().contains("text")||!it.value()["text"].is_string()||it.value()["text"].get<std::string>().size()>720)throw std::runtime_error("Invalid saved reply target");
    if(!data["intentIds"].is_object()||!data["attachments"].is_object())throw std::runtime_error("Invalid draft identities");
    for(auto it=data["drafts"].begin();it!=data["drafts"].end();++it)if(it.key().empty()||it.key().size()>=512||!it.value().is_string()||it.value().get<std::string>().size()>48000)throw std::runtime_error("Invalid draft text");
    for(auto it=data["attachments"].begin();it!=data["attachments"].end();++it){
        if(it.key().empty()||it.key().size()>=512||!it.value().is_array()||it.value().size()>4)throw std::runtime_error("Invalid draft attachments");
        for(const auto& image:it.value())if(!image.is_object()||!image.contains("id")||!image["id"].is_string()||image["id"].get<std::string>().empty()||!image.contains("path")||!image["path"].is_string()||image["path"].get<std::string>().size()>=32768)throw std::runtime_error("Invalid draft image");
    }
    for(auto it=data["intentIds"].begin();it!=data["intentIds"].end();++it){
        if(!it.value().is_string()||(!data["drafts"].contains(it.key())&&!data["attachments"].contains(it.key())&&!data["replyTargets"].contains(it.key())))throw std::runtime_error("Invalid saved message identity");
        auto id=it.value().get<std::string>();if(id.size()!=36||id.find_first_not_of("0123456789abcdefABCDEF-")!=std::string::npos)throw std::runtime_error("Invalid saved message identity");
    }
    data["version"]=3;return data;
}
}
