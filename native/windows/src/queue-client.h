#pragma once
#include <windows.h>
#include <thread>
#include <mutex>
#include <deque>
#include <filesystem>
#include <fstream>
#include <string>
#include <stdexcept>
#include "../vendor/nlohmann/json.hpp"
using Json = nlohmann::json;

// Separate subscription and command connections leave the corner lease intact.
// Both workers wait on handles; the UI thread never performs pipe I/O.
class QueueClient {
    HANDLE stopEvent=nullptr, commandEvent=nullptr, detailsEvent=nullptr, detailsCancel=nullptr;
    std::thread reader, writer, detailsReader;
    std::mutex mutex;
    std::deque<Json> results, requests;
    Json latestDetails;
    std::string pipeName, token;
    DWORD serverPid=0;
    HANDLE connect() {
        HANDLE pipe=CreateFileA(pipeName.c_str(), GENERIC_READ|GENERIC_WRITE,0,nullptr,
            OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
        if(pipe==INVALID_HANDLE_VALUE) throw std::runtime_error("Queue connection is unavailable.");
        ULONG pid=0;
        if(!GetNamedPipeServerProcessId(pipe,&pid) || pid!=serverPid) {
            CloseHandle(pipe); throw std::runtime_error("Queue server identity changed.");
        }
        return pipe;
    }
    DWORD transfer(HANDLE pipe, bool write, char* data, DWORD length, DWORD timeout, HANDLE cancel=nullptr) {
        if(cancel&&WaitForSingleObject(cancel,0)==WAIT_OBJECT_0)throw std::runtime_error("Read superseded.");
        HANDLE event=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        if(!event) throw std::runtime_error("Queue event creation failed.");
        OVERLAPPED operation{}; operation.hEvent=event;
        DWORD count=0;
        BOOL ok=write?WriteFile(pipe,data,length,&count,&operation):ReadFile(pipe,data,length,&count,&operation);
        DWORD failure=ok?ERROR_SUCCESS:GetLastError();
        if(!ok && failure==ERROR_IO_PENDING) {
            HANDLE handles[]{stopEvent,event,cancel};
            const auto waited=WaitForMultipleObjects(cancel?3:2,handles,FALSE,timeout);
            if(waited==WAIT_OBJECT_0+1) {
                if(!GetOverlappedResult(pipe,&operation,&count,FALSE)) failure=GetLastError();
                else failure=ERROR_SUCCESS;
            } else {
                CancelIoEx(pipe,&operation); WaitForSingleObject(event,INFINITE);
                failure=ERROR_OPERATION_ABORTED;
            }
        }
        CloseHandle(event);
        if(failure!=ERROR_SUCCESS || !count) throw std::runtime_error("Queue connection closed or timed out.");
        return count;
    }
    void send(HANDLE pipe, Json request,HANDLE cancel=nullptr) {
        request["token"]=token;
        std::string frame=request.dump()+"\n";
        size_t sent=0;
        while(sent<frame.size()) sent+=transfer(pipe,true,frame.data()+sent,
            static_cast<DWORD>(frame.size()-sent),5000,cancel);
    }
    void deliver(Json value, bool state=false) {
        std::lock_guard lock(mutex);
        if(state) {
            // Coalesce only state, preserving command responses and errors.
            for(auto it=results.begin();it!=results.end();)
                if(it->value("event","")=="state") it=results.erase(it); else ++it;
        }
        results.push_back(std::move(value)); SetEvent(event);
    }
    Json receive(HANDLE pipe, std::string& buffer, DWORD timeout,HANDLE cancel=nullptr) {
        while(buffer.find('\n')==std::string::npos) {
            char chunk[16384]; DWORD n=transfer(pipe,false,chunk,sizeof(chunk),timeout,cancel);
            buffer.append(chunk,n);
            if(buffer.size()>2*1024*1024) throw std::runtime_error("Queue update exceeds the size limit.");
        }
        auto end=buffer.find('\n'); auto value=Json::parse(buffer.substr(0,end));
        buffer.erase(0,end+1); return value;
    }
public:
    HANDLE event=nullptr;
    ~QueueClient(){close();}
    void start(const std::filesystem::path& descriptor) {
        std::ifstream file(descriptor); std::string magic,pid;
        std::getline(file,magic);std::getline(file,pipeName);std::getline(file,token);std::getline(file,pid);
        if(magic!="work-updates-native-v1" || pipeName.rfind("\\\\.\\pipe\\work-updates-native-",0)!=0 ||
            token.size()!=64 || token.find_first_not_of("0123456789abcdef")!=std::string::npos)
            throw std::runtime_error("Invalid queue descriptor.");
        serverPid=static_cast<DWORD>(std::stoul(pid));
        stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        commandEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);
        detailsEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);
        detailsCancel=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
        if(!stopEvent || !commandEvent || !detailsEvent || !detailsCancel || !event) throw std::runtime_error("Queue events could not be created.");
        reader=std::thread([this]{
            DWORD delay=250;
            while(WaitForSingleObject(stopEvent,0)!=WAIT_OBJECT_0) {
                HANDLE pipe=INVALID_HANDLE_VALUE;
                try {
                    pipe=connect(); send(pipe,{{"method","subscribe"}}); std::string buffer;
                    while(WaitForSingleObject(stopEvent,0)!=WAIT_OBJECT_0) {
                        deliver(receive(pipe,buffer,INFINITE),true);delay=250;
                    }
                } catch(const std::exception& error) {
                    if(WaitForSingleObject(stopEvent,0)!=WAIT_OBJECT_0)
                        deliver({{"event","connection-error"},{"error",error.what()}});
                }
                if(pipe!=INVALID_HANDLE_VALUE)CloseHandle(pipe);
                // Retry only a disconnected subscription. The corner lease and
                // command worker remain independent; no connected-state polling.
                if(WaitForSingleObject(stopEvent,delay)==WAIT_OBJECT_0)break;
                delay=std::min<DWORD>(delay*2,5000);
            }
        });
        // A latest-only read lane cannot wait behind a send or hold its writer.
        // Superseded reads cancel overlapped I/O and never produce UI errors.
        detailsReader=std::thread([this]{
            HANDLE handles[]{stopEvent,detailsEvent};
            while(WaitForMultipleObjects(2,handles,FALSE,INFINITE)==WAIT_OBJECT_0+1) {
                Json request;
                {std::lock_guard lock(mutex);if(latestDetails.empty())continue;request=std::move(latestDetails);latestDetails=Json();ResetEvent(detailsCancel);}
                HANDLE pipe=INVALID_HANDLE_VALUE;Json result;
                try {pipe=connect();send(pipe,request,detailsCancel);std::string buffer;result=receive(pipe,buffer,15000,detailsCancel);}
                catch(const std::exception& error){result={{"ok",false},{"error",error.what()}};}
                if(pipe!=INVALID_HANDLE_VALUE)CloseHandle(pipe);
                if(WaitForSingleObject(stopEvent,0)==WAIT_OBJECT_0)break;
                if(WaitForSingleObject(detailsCancel,0)==WAIT_OBJECT_0)continue;
                result["event"]="details";result["command"]="details";result["input"]=request["input"];deliver(std::move(result));
            }
        });
        writer=std::thread([this]{
            HANDLE handles[]{stopEvent,commandEvent};
            while(WaitForMultipleObjects(2,handles,FALSE,INFINITE)==WAIT_OBJECT_0+1) {
                Json request;
                {std::lock_guard lock(mutex); if(requests.empty())continue; request=std::move(requests.front());requests.pop_front();}
                HANDLE pipe=INVALID_HANDLE_VALUE; Json result;
                try {
                    pipe=connect();send(pipe,request);std::string buffer;
                    result=receive(pipe,buffer,request.value("command","")=="send"?245000:15000);
                } catch(const std::exception& error) {
                    const bool delivery=request.value("command","")=="send"||request.value("command","")=="queueMessage";
                    result={{"ok",false},{"error",delivery?
                        "Delivery could not be confirmed. Your draft is saved. Open chat to check before sending again.":error.what()}};
                    if(delivery)result["delivery"]="uncertain";
                }
                if(pipe!=INVALID_HANDLE_VALUE)CloseHandle(pipe);
                result["event"]="command";result["command"]=request["command"];result["input"]=request["input"];
                deliver(std::move(result));
            }
        });
    }
    bool command(std::string method, Json input=Json::object()) {
        std::lock_guard lock(mutex);
        if(!event || !requests.empty())return false;
        requests.push_back({{"method","command"},{"command",method},{"input",std::move(input)}});
        SetEvent(commandEvent);return true;
    }
    bool details(Json input) {
        std::lock_guard lock(mutex);if(!event)return false;
        latestDetails={{"method","command"},{"command","details"},{"input",std::move(input)}};
        SetEvent(detailsCancel);SetEvent(detailsEvent);return true;
    }
    void cancelDetails(){std::lock_guard lock(mutex);latestDetails=Json();if(detailsCancel)SetEvent(detailsCancel);}
    std::deque<Json> take() {std::lock_guard lock(mutex); std::deque<Json> copy;copy.swap(results);return copy;}
    void close() {
        if(stopEvent)SetEvent(stopEvent);
        if(reader.joinable())reader.join();if(writer.joinable())writer.join();if(detailsReader.joinable())detailsReader.join();
        for(HANDLE* handle:{&stopEvent,&commandEvent,&detailsEvent,&detailsCancel,&event})if(*handle){CloseHandle(*handle);*handle=nullptr;}
    }
};
