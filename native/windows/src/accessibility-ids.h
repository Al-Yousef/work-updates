#pragma once
#include <map>
#include <list>
#include <set>
#include <string>
#include <vector>
#include <limits>
#include <iterator>
#include <utility>

// IDs are stable while retained and are never reused within this COM object's
// lifetime. Current controls are pinned; old invisible controls are evicted.
// An old client reference then becomes unavailable, never a different action.
class AccessibleIds {
    struct Entry{long value;std::list<long>::iterator position;};
    std::map<std::string,Entry> ids;
    std::map<long,std::map<std::string,Entry>::iterator> keys;
    std::list<long> recent;
    std::set<std::string> current;
    long next=1;
public:
    static constexpr size_t capacity=2048;
    size_t size() const{return ids.size();}
    const std::string* key(long value) const{auto found=keys.find(value);return found==keys.end()?nullptr:&found->second->first;}
    long id(const std::string& key){
        if(auto found=ids.find(key);found!=ids.end()){
            recent.splice(recent.end(),recent,found->second.position);return found->second.value;
        }
        if(next==std::numeric_limits<long>::max())return 0;
        if(ids.size()>=capacity){
            auto oldest=recent.begin();while(oldest!=recent.end()&&current.contains(keys.at(*oldest)->first))++oldest;
            if(oldest==recent.end())return 0;
            ids.erase(keys.at(*oldest));keys.erase(*oldest);recent.erase(oldest);
        }
        const long value=next++;recent.push_back(value);auto entry=ids.emplace(key,Entry{value,std::prev(recent.end())}).first;keys.emplace(value,entry);return value;
    }
    bool prepare(const std::vector<std::string>& visible){
        std::set<std::string> pinned(visible.begin(),visible.end());
        if(pinned.size()>capacity||pinned.size()!=visible.size())return false;
        current=std::move(pinned);
        for(const auto& key:visible)if(!id(key))return false;
        return true;
    }
};
