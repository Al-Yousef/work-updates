#pragma once
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <string>
#include <cstring>

namespace taskbar {
// Microsoft public symbols for this exact installed DLL. Unknown versions are
// deliberately refused. RVAs are relative to the validated module, never VAs.
constexpr char dllHash[]="cf7e002533def6628ba121481a703a06fc30accaa5e5cadd1a412f65f2d8ba77";
constexpr wchar_t adapterFilename[]=L"WorkUpdatesTaskbar-v2.dll";
struct Site { const char* name; DWORD rva; std::array<unsigned char,16> bytes; };
constexpr Site sites[] = {
    {"AugmentedEntryPointButton::OnHoverInvoke",0x3cc58,{0x48,0x89,0x5c,0x24,0x08,0x57,0x48,0x83,0xec,0x30,0x0f,0x29,0x74,0x24,0x20,0x48}},
    {"TaskbarResources::OnAugmentedEntryPointButtonClick",0xe9350,{0x4c,0x89,0x44,0x24,0x18,0x48,0x89,0x4c,0x24,0x08,0x55,0x53,0x56,0x57,0x48,0x8b}},
    {"ExperienceToggleButton::OnPointerExited",0x1bae00,{0x40,0x53,0x48,0x83,0xec,0x20,0x48,0x8b,0xd9,0xe8,0x9a,0x00,0x00,0x00,0x48,0x8b}}
};
inline std::string sha256(const std::filesystem::path& path) {
    BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
    std::string result;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)return result;
    if(BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)>=0) {
        std::ifstream file(path,std::ios::binary); std::array<unsigned char,65536> block{};
        bool ok=static_cast<bool>(file);
        while(ok && file) {
            file.read(reinterpret_cast<char*>(block.data()),block.size());
            const auto count=file.gcount();
            if(count && BCryptHashData(hash,block.data(),static_cast<ULONG>(count),0)<0)ok=false;
        }
        if(file.bad())ok=false;
        std::array<unsigned char,32> digest{};
        if(ok && BCryptFinishHash(hash,digest.data(),digest.size(),0)>=0) {
            constexpr char hex[]="0123456789abcdef";
            for(const auto byte:digest) {result+=hex[byte>>4]; result+=hex[byte&15];}
        }
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(algorithm,0); return result;
}
inline bool profileMatches(const std::filesystem::path& path) { return sha256(path)==dllHash; }
inline bool validateLoaded(HMODULE module) {
    wchar_t path[32768]{};
    if(!module || !GetModuleFileNameW(module,path,32768) || !profileMatches(path))return false;
    const auto base=reinterpret_cast<const unsigned char*>(module);
    const auto dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if(dos->e_magic!=IMAGE_DOS_SIGNATURE || dos->e_lfanew<=0)return false;
    const auto pe=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    if(pe->Signature!=IMAGE_NT_SIGNATURE || pe->FileHeader.Machine!=IMAGE_FILE_MACHINE_AMD64)return false;
    for(const auto& site:sites) {
        if(site.rva+site.bytes.size()>pe->OptionalHeader.SizeOfImage ||
            memcmp(base+site.rva,site.bytes.data(),site.bytes.size()))return false;
        MEMORY_BASIC_INFORMATION memory{};
        if(!VirtualQuery(base+site.rva,&memory,sizeof(memory)) || memory.State!=MEM_COMMIT ||
            !(memory.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
    }
    return true;
}
}
