#pragma once
#include <inspectable.h>
#include <winstring.h>
#include <string_view>

namespace taskbar {
inline bool weatherSender(IInspectable* sender) noexcept {
    if(!sender)return false;
    HSTRING name=nullptr;
    const HRESULT result=sender->GetRuntimeClassName(&name);
    UINT32 length=0;
    const wchar_t* text=SUCCEEDED(result)?WindowsGetStringRawBuffer(name,&length):nullptr;
    const bool weather=text && std::wstring_view(text,length)==L"Taskbar.AugmentedEntryPointButton";
    if(name)WindowsDeleteString(name);
    return weather;
}
}
