#pragma once
#include <oleacc.h>
#include <functional>
#include <vector>
#include <map>
#include <atomic>
#include "accessibility-ids.h"

struct AccessibleItem {
    std::string key;
    std::wstring name,description,value;
    RECT box{};
    long role=ROLE_SYSTEM_PUSHBUTTON,state=STATE_SYSTEM_FOCUSABLE;
    HWND child=nullptr;
};
class AccessibleEnumeration final:public IEnumVARIANT {
    ULONG refs=1;std::vector<long> ids;size_t position=0;
    std::function<std::vector<long>()> refresh;IUnknown* owner;
public:
    AccessibleEnumeration(std::function<std::vector<long>()> read,IUnknown* root):refresh(std::move(read)),owner(root){owner->AddRef();ids=refresh();}
    ~AccessibleEnumeration(){owner->Release();}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) override {if(!out)return E_POINTER;*out=nullptr;if(iid==IID_IUnknown||iid==IID_IEnumVARIANT){*out=static_cast<IEnumVARIANT*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
    ULONG STDMETHODCALLTYPE AddRef() override {return ++refs;}
    ULONG STDMETHODCALLTYPE Release() override {auto n=--refs;if(!n)delete this;return n;}
    HRESULT STDMETHODCALLTYPE Next(ULONG count,VARIANT* out,ULONG* fetched) override {if(!out||(!fetched&&count!=1))return E_POINTER;ULONG read=0;while(read<count&&position<ids.size()){VariantInit(out+read);out[read].vt=VT_I4;out[read++].lVal=ids[position++];}if(fetched)*fetched=read;return read==count?S_OK:S_FALSE;}
    HRESULT STDMETHODCALLTYPE Skip(ULONG count) override {const auto read=std::min<size_t>(count,ids.size()-position);position+=read;return read==count?S_OK:S_FALSE;}
    HRESULT STDMETHODCALLTYPE Reset() override {ids=refresh();position=0;return S_OK;}
    HRESULT STDMETHODCALLTYPE Clone(IEnumVARIANT** out) override {if(!out)return E_POINTER;auto clone=new AccessibleEnumeration(refresh,owner);clone->ids=ids;clone->position=position;*out=clone;return S_OK;}
};
// Stable IDs belong to item identity, never a position in the changing hit list.
// Clients retain a COM reference; detach makes those references inert on exit.
class CanvasAccessible final:public IAccessible,public IEnumVARIANT {
    std::atomic<ULONG> refs{1};
    AccessibleIds identity;
    std::vector<long> enumeration;size_t enumPosition=0;
    HWND window;
    std::function<std::vector<AccessibleItem>()> snapshot;
    std::vector<AccessibleItem> items(){
        auto value=snapshot();std::vector<std::string> visible;visible.reserve(value.size());
        for(const auto& item:value)visible.push_back(item.key);
        if(!identity.prepare(visible))return {};return value;
    }
    HRESULT find(VARIANT child,AccessibleItem& item) {
        if(child.vt!=VT_I4||child.lVal<0)return E_INVALIDARG;
        if(!window||!snapshot)return CO_E_OBJNOTCONNECTED;
        if(child.lVal==CHILDID_SELF){item.name=L"Hyphen";item.role=ROLE_SYSTEM_PANE;GetWindowRect(window,&item.box);item.state=IsWindowVisible(window)?0:STATE_SYSTEM_INVISIBLE;return S_OK;}
        auto current=items();auto key=identity.key(child.lVal);if(!key)return S_FALSE;
        for(const auto& value:current)if(value.key==*key){item=value;return S_OK;}
        return S_FALSE;
    }
    HRESULT stringValue(VARIANT child,BSTR* out,int which) {
        if(!out)return E_POINTER;*out=nullptr;AccessibleItem item;auto result=find(child,item);if(result!=S_OK)return result;
        const auto& value=which==0?item.name:which==1?item.description:item.value;
        if(value.empty())return S_FALSE;*out=SysAllocStringLen(value.c_str(),static_cast<UINT>(value.size()));return *out?S_OK:E_OUTOFMEMORY;
    }
public:
    CanvasAccessible(HWND hwnd,std::function<std::vector<AccessibleItem>()> read):window(hwnd),snapshot(std::move(read)){}
    void detach(){window=nullptr;snapshot={};}
    size_t retainedIds() const{return identity.size();}
    long id(const std::string& key){return identity.id(key);}
    bool item(long child,AccessibleItem& value){VARIANT v{};v.vt=VT_I4;v.lVal=child;return find(v,value)==S_OK;}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) override {if(!out)return E_POINTER;*out=nullptr;if(iid==IID_IEnumVARIANT)*out=static_cast<IEnumVARIANT*>(this);else if(iid==IID_IUnknown||iid==IID_IDispatch||iid==IID_IAccessible)*out=static_cast<IAccessible*>(this);else return E_NOINTERFACE;AddRef();return S_OK;}
    ULONG STDMETHODCALLTYPE AddRef() override {return ++refs;}
    ULONG STDMETHODCALLTYPE Release() override {auto n=--refs;if(!n)delete this;return n;}
    HRESULT STDMETHODCALLTYPE Next(ULONG count,VARIANT* out,ULONG* fetched) override {if(!out||(!fetched&&count!=1))return E_POINTER;ULONG read=0;while(read<count&&enumPosition<enumeration.size()){VariantInit(out+read);out[read].vt=VT_I4;out[read++].lVal=enumeration[enumPosition++];}if(fetched)*fetched=read;return read==count?S_OK:S_FALSE;}
    HRESULT STDMETHODCALLTYPE Skip(ULONG count) override {const auto read=std::min<size_t>(count,enumeration.size()-enumPosition);enumPosition+=read;return read==count?S_OK:S_FALSE;}
    HRESULT STDMETHODCALLTYPE Reset() override {enumeration.clear();enumPosition=0;if(!snapshot)return CO_E_OBJNOTCONNECTED;for(const auto& i:items())enumeration.push_back(id(i.key));return S_OK;}
    HRESULT STDMETHODCALLTYPE Clone(IEnumVARIANT** out) override {if(!out)return E_POINTER;std::vector<long> remaining(enumeration.begin()+enumPosition,enumeration.end());*out=new AccessibleEnumeration([remaining]{return remaining;},static_cast<IAccessible*>(this));return S_OK;}
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* out) override {if(!out)return E_POINTER;*out=0;return S_OK;}
    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT,LCID,ITypeInfo**) override {return E_NOTIMPL;}
    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID,LPOLESTR*,UINT,LCID,DISPID*) override {return DISP_E_UNKNOWNNAME;}
    HRESULT STDMETHODCALLTYPE Invoke(DISPID,REFIID,LCID,WORD,DISPPARAMS*,VARIANT*,EXCEPINFO*,UINT*) override {return DISP_E_MEMBERNOTFOUND;}
    HRESULT STDMETHODCALLTYPE get_accParent(IDispatch** out) override {if(!out)return E_POINTER;*out=nullptr;return window?AccessibleObjectFromWindow(window,OBJID_WINDOW,IID_IDispatch,reinterpret_cast<void**>(out)):CO_E_OBJNOTCONNECTED;}
    HRESULT STDMETHODCALLTYPE get_accChildCount(long* out) override {if(!out)return E_POINTER;*out=0;if(!snapshot)return CO_E_OBJNOTCONNECTED;*out=static_cast<long>(items().size());return S_OK;}
    HRESULT STDMETHODCALLTYPE get_accChild(VARIANT child,IDispatch** out) override {if(!out)return E_POINTER;*out=nullptr;AccessibleItem i;auto hr=find(child,i);if(hr!=S_OK)return hr;if(!i.child)return S_FALSE;return AccessibleObjectFromWindow(i.child,OBJID_CLIENT,IID_IDispatch,reinterpret_cast<void**>(out));}
    HRESULT STDMETHODCALLTYPE get_accName(VARIANT v,BSTR* out) override {return stringValue(v,out,0);}
    HRESULT STDMETHODCALLTYPE get_accValue(VARIANT v,BSTR* out) override {return stringValue(v,out,2);}
    HRESULT STDMETHODCALLTYPE get_accDescription(VARIANT v,BSTR* out) override {return stringValue(v,out,1);}
    HRESULT STDMETHODCALLTYPE get_accRole(VARIANT v,VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);AccessibleItem i;auto hr=find(v,i);if(hr==S_OK){out->vt=VT_I4;out->lVal=i.role;}return hr;}
    HRESULT STDMETHODCALLTYPE get_accState(VARIANT v,VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);AccessibleItem i;auto hr=find(v,i);if(hr==S_OK){out->vt=VT_I4;out->lVal=i.state;}return hr;}
    HRESULT STDMETHODCALLTYPE get_accHelp(VARIANT v,BSTR* out) override {return stringValue(v,out,1);}
    HRESULT STDMETHODCALLTYPE get_accHelpTopic(BSTR* out,VARIANT,long* topic) override {if(out)*out=nullptr;if(topic)*topic=0;return S_FALSE;}
    HRESULT STDMETHODCALLTYPE get_accKeyboardShortcut(VARIANT child,BSTR* out) override {if(!out)return E_POINTER;*out=nullptr;AccessibleItem i;auto hr=find(child,i);if(hr!=S_OK)return hr;if(i.key=="search"){*out=SysAllocString(L"Ctrl+F");return S_OK;}return S_FALSE;}
    HRESULT STDMETHODCALLTYPE get_accFocus(VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);if(!snapshot)return CO_E_OBJNOTCONNECTED;for(const auto& i:items())if(i.state&STATE_SYSTEM_FOCUSED){out->vt=VT_I4;out->lVal=id(i.key);return S_OK;}return S_FALSE;}
    HRESULT STDMETHODCALLTYPE get_accSelection(VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);if(!snapshot)return CO_E_OBJNOTCONNECTED;for(const auto& i:items())if(i.state&STATE_SYSTEM_SELECTED){out->vt=VT_I4;out->lVal=id(i.key);return S_OK;}return S_FALSE;}
    HRESULT STDMETHODCALLTYPE get_accDefaultAction(VARIANT child,BSTR* out) override {if(!out)return E_POINTER;*out=nullptr;AccessibleItem i;auto hr=find(child,i);if(hr!=S_OK)return hr;if(i.role!=ROLE_SYSTEM_PUSHBUTTON&&i.role!=ROLE_SYSTEM_LISTITEM)return S_FALSE;*out=SysAllocString(L"Activate");return S_OK;}
    HRESULT STDMETHODCALLTYPE accSelect(long flags,VARIANT child) override {AccessibleItem i;auto hr=find(child,i);if(hr!=S_OK)return hr;if(flags!=SELFLAG_TAKEFOCUS)return E_INVALIDARG;if(!(i.state&STATE_SYSTEM_FOCUSABLE)||i.state&STATE_SYSTEM_UNAVAILABLE)return S_FALSE;return PostMessageW(window,WM_APP+217,child.lVal,0)?S_OK:E_FAIL;}
    HRESULT STDMETHODCALLTYPE accLocation(long* x,long* y,long* w,long* h,VARIANT v) override {if(!x||!y||!w||!h)return E_POINTER;AccessibleItem i;auto hr=find(v,i);if(hr!=S_OK)return hr;*x=i.box.left;*y=i.box.top;*w=i.box.right-i.box.left;*h=i.box.bottom-i.box.top;return S_OK;}
    HRESULT STDMETHODCALLTYPE accNavigate(long direction,VARIANT start,VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);if(!snapshot)return CO_E_OBJNOTCONNECTED;if(start.vt!=VT_I4)return E_INVALIDARG;auto visible=items();if(visible.empty())return S_FALSE;
        int index=-1;if(start.lVal==CHILDID_SELF){if(direction==NAVDIR_FIRSTCHILD)index=0;else if(direction==NAVDIR_LASTCHILD)index=static_cast<int>(visible.size())-1;}
        else for(size_t n=0;n<visible.size();++n)if(id(visible[n].key)==start.lVal){if(direction==NAVDIR_NEXT)index=static_cast<int>(n)+1;else if(direction==NAVDIR_PREVIOUS)index=static_cast<int>(n)-1;break;}
        if(index<0||index>=static_cast<int>(visible.size()))return S_FALSE;out->vt=VT_I4;out->lVal=id(visible[index].key);return S_OK;}
    HRESULT STDMETHODCALLTYPE accHitTest(long x,long y,VARIANT* out) override {if(!out)return E_POINTER;VariantInit(out);if(!snapshot)return CO_E_OBJNOTCONNECTED;POINT p{x,y};auto visible=items();for(auto it=visible.rbegin();it!=visible.rend();++it)if(PtInRect(&it->box,p)){out->vt=VT_I4;out->lVal=id(it->key);return S_OK;}RECT box{};GetWindowRect(window,&box);if(PtInRect(&box,p)){out->vt=VT_I4;out->lVal=CHILDID_SELF;return S_OK;}return S_FALSE;}
    HRESULT STDMETHODCALLTYPE accDoDefaultAction(VARIANT child) override {AccessibleItem i;auto hr=find(child,i);if(hr!=S_OK)return hr;if(i.state&STATE_SYSTEM_UNAVAILABLE)return S_FALSE;if(i.role!=ROLE_SYSTEM_PUSHBUTTON&&i.role!=ROLE_SYSTEM_LISTITEM)return S_FALSE;return PostMessageW(window,WM_APP+216,child.lVal,0)?S_OK:E_FAIL;}
    HRESULT STDMETHODCALLTYPE put_accName(VARIANT,BSTR) override {return E_NOTIMPL;}
    HRESULT STDMETHODCALLTYPE put_accValue(VARIANT,BSTR) override {return E_NOTIMPL;}
};
