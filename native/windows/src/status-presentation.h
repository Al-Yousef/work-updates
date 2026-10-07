#pragma once
#include "../vendor/nlohmann/json.hpp"
#include <string>
namespace statuspresentation {
inline std::string label(const nlohmann::json& card) {
    auto text=card.value("label",std::string());
    if(card.value("urgent",false))text="Urgent · "+text;
    if(!card.contains("availability")&&!card.value("owner",nlohmann::json::object()).value("online",true))
        text="Last known · "+text;
    return text;
}
}
