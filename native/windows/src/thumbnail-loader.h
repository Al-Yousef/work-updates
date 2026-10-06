#pragma once
#include <thread>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <set>
#include <vector>
// Included after Com/require/wide. WIC objects live entirely on this worker;
// only bounded premultiplied pixels cross to the UI's Direct2D device.
class ThumbnailLoader {
public:
    struct Preview {std::string file;UINT width=0,height=0;std::vector<BYTE> pixels;};
    HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    unsigned auditDelayMs=0; // Set before start, only in an audit-capture session.
private:
    std::mutex mutex;std::condition_variable ready;std::thread worker;
    std::deque<std::string> requests;std::deque<Preview> completed;std::set<std::string> queued;
    bool stopping=false;
public:
    void start(){if(!event)throw std::runtime_error("Thumbnail event creation failed.");worker=std::thread([this]{
        const auto initialized=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
        {
            Com<IWICImagingFactory> imaging;
            const auto created=SUCCEEDED(initialized)?CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(imaging.put())):initialized;
            for(;;){
                Preview result;
                {std::unique_lock lock(mutex);ready.wait(lock,[&]{return stopping||!requests.empty();});if(stopping)break;result.file=std::move(requests.front());requests.pop_front();}
                if(auditDelayMs){std::unique_lock lock(mutex);if(ready.wait_for(lock,std::chrono::milliseconds(auditDelayMs),[&]{return stopping;}))break;}
                try {
                    require(created,"Thumbnail factory");Com<IWICBitmapDecoder> decoder;
                    require(imaging->CreateDecoderFromFilename(wide(result.file).c_str(),nullptr,GENERIC_READ,WICDecodeMetadataCacheOnDemand,decoder.put()),"Read thumbnail");
                    Com<IWICBitmapFrameDecode> frame;require(decoder->GetFrame(0,frame.put()),"Thumbnail frame");UINT w=0,h=0;require(frame->GetSize(&w,&h),"Thumbnail size");
                    if(!w||!h||static_cast<uint64_t>(w)*h>50000000)throw std::runtime_error("Thumbnail exceeds preview limit");
                    const auto scale=std::min(1.0,768.0/std::max(w,h));result.width=std::max(1U,static_cast<UINT>(w*scale));result.height=std::max(1U,static_cast<UINT>(h*scale));
                    Com<IWICBitmapScaler> scaler;require(imaging->CreateBitmapScaler(scaler.put()),"Thumbnail scaler");require(scaler->Initialize(frame.get(),result.width,result.height,WICBitmapInterpolationModeFant),"Scale thumbnail");
                    Com<IWICFormatConverter> converter;require(imaging->CreateFormatConverter(converter.put()),"Thumbnail converter");require(converter->Initialize(scaler.get(),GUID_WICPixelFormat32bppPBGRA,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom),"Convert thumbnail");
                    result.pixels.resize(result.width*result.height*4);require(converter->CopyPixels(nullptr,result.width*4,static_cast<UINT>(result.pixels.size()),result.pixels.data()),"Thumbnail pixels");
                }catch(...){result.pixels.clear();}
                {std::lock_guard lock(mutex);if(stopping)break;completed.push_back(std::move(result));SetEvent(event);}
            }
        }
        if(SUCCEEDED(initialized))CoUninitialize();
    });}
    bool request(const std::string& file){std::lock_guard lock(mutex);if(stopping||queued.contains(file)||queued.size()>=32)return false;queued.insert(file);requests.push_back(file);ready.notify_one();return true;}
    std::deque<Preview> take(){std::lock_guard lock(mutex);std::deque<Preview> result;result.swap(completed);for(const auto& p:result)queued.erase(p.file);return result;}
    void close(){ {std::lock_guard lock(mutex);stopping=true;requests.clear();ready.notify_one();}if(worker.joinable())worker.join();if(event){CloseHandle(event);event=nullptr;} }
    ~ThumbnailLoader(){close();}
};
