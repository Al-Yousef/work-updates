#include "../src/accessibility-ids.h"
#include <iostream>
#include <stdexcept>
#include <algorithm>
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
int main(){try{
    AccessibleIds registry;check(registry.prepare({"pinned","original"}),"prepare original controls");
    const auto pinned=registry.id("pinned"),original=registry.id("original");
    for(int i=0;i<10000;++i){
        const auto key="changing-control-"+std::to_string(i);
        check(registry.prepare({"pinned",key}),"prepare changing controls");
        check(registry.id("pinned")==pinned,"visible control identity remains stable");
        check(registry.size()<=AccessibleIds::capacity,"all identity indexes remain bounded");
    }
    check(registry.size()==AccessibleIds::capacity,"retained identities fill only the finite capacity");
    check(registry.key(original)==nullptr,"retired client identity is unavailable");
    check(registry.prepare({"pinned","original"}),"return retired control");
    check(registry.id("original")!=original,"retired ID is never reused even for a returning control");
    std::vector<std::string> current;for(size_t i=0;i<AccessibleIds::capacity;++i)current.push_back("visible-"+std::to_string(i));
    check(registry.prepare(current),"all current controls remain pinned at capacity");
    check(registry.id("not-visible")==0,"new non-current identity cannot evict a current control");
    const auto last=registry.id(current.back());std::reverse(current.begin(),current.end());
    check(registry.prepare(current)&&registry.id(current.front())==last,"current identity survives reordered snapshots");
    current.push_back("overflow");check(!registry.prepare(current),"oversized projection is held");
    check(registry.size()<=AccessibleIds::capacity,"held overflow cannot grow storage");
    check(!registry.prepare({"duplicate","duplicate"}),"duplicate identity is held");
    std::cout<<"PASS 10000 changing accessibility controls: bounded indexes, pinned current IDs, unavailable retired IDs and no ID reuse\n";return 0;
}catch(const std::exception& error){std::cerr<<"FAIL "<<error.what()<<"\n";return 1;}}
