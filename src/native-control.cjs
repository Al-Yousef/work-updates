'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { recovery } = require('./diagnostics.cjs');

// A live pipe connection owns the corner. Closing/crashing releases ownership.
// This does not change the user's saved launcher preference.
class NativeControl {
  constructor({ directory, changed, status, quit, state, command, log }) {
    this.log=log;
    this.file = path.join(directory, 'native-control.info');
    this.pipe = process.platform === 'win32'
      ? '\\\\.\\pipe\\work-updates-native-' + crypto.randomUUID()
      : null;
    this.token = crypto.randomBytes(32).toString('hex');
    this.changed = changed;
    this.status = status;
    this.quit = quit;
    this.state = state;
    this.command = command;
    this.subscribers = new Set();
    this.owner = null;
    this.clients = new Set();
  }
  get claimed() { return this.owner !== null; }
  async start() {
    if (this.server) throw new Error('Native control is already started');
    if (process.platform !== 'win32') {
      // Darwin limits the entire Unix socket path to 103 bytes. App data and
      // runner temporary directories can be much longer than that.
      const temporary = os.tmpdir();
      const root = Buffer.byteLength(path.join(temporary, 'hyphen-XXXXXX', 'c.sock')) <= 103
        ? temporary : '/tmp';
      this.endpointDirectory = fs.mkdtempSync(path.join(root, 'hyphen-'));
      fs.chmodSync(this.endpointDirectory, 0o700);
      this.pipe = path.join(this.endpointDirectory, 'c.sock');
    }
    this.server = net.createServer(socket => {
      const nativeSessionId=crypto.randomUUID();socket.diagnosticSession=nativeSessionId;
      this.clients.add(socket);
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('close', () => {
        this.log?.write('native.pipe.disconnected',{nativeSessionId,connected:false},{context:null});
        this.clients.delete(socket);
        this.subscribers.delete(socket);
        if (this.owner === socket) {
          this.owner = null;
          this.changed(false);
        }
      });
      let handled = false;
      socket.on('data', async data => {
        if (handled) return socket.destroy();
        buffer += data;
        if (Buffer.byteLength(buffer) > 131072) return socket.destroy();
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (buffer.trim()) return socket.destroy();
        let request;
        try { request = JSON.parse(line); } catch { return socket.destroy(); }
        const supplied = Buffer.from(typeof request?.token === 'string' ? request.token : '');
        const expected = Buffer.from(this.token);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
          return socket.end(JSON.stringify({ok:false, error:'Unauthorized'}) + '\n');
        handled = true;
        this.log?.write('native.pipe.connected',{nativeSessionId,method:request.method,connected:true},{context:null});
        if (request.method === 'claimCorner') {
          if (this.owner && this.owner !== socket)
            return socket.end(JSON.stringify({ok:false, error:'Corner already has an owner'}) + '\n');
          this.owner = socket;
          socket.setTimeout(0);
          this.changed(true);
          socket.write(JSON.stringify({ok:true, cornerOwner:'native', pid:process.pid}) + '\n');
        } else if (request.method === 'subscribe' && this.state) {
          socket.setTimeout(0);
          this.subscribers.add(socket);
          socket.on('drain', () => {
            if (socket.latestState) {
              const latest = socket.latestState; socket.latestState = null;
              socket.write(latest);
            }
          });
          this.sendState(socket, this.state());
        } else if (request.method === 'command' && this.command) {
          if(this.maintenance)return socket.end(JSON.stringify({ok:false,error:'Hyphen is shutting down for maintenance. Keep your draft and retry after restart.',code:'UPDATE_IN_PROGRESS'})+'\n');
          if (!['action', 'undo', 'details', 'open', 'refresh', 'send', 'queueMessage', 'clearMessages', 'logs','assistantAsk','assistantUse','attachImages','openAttachment'].includes(request.command))
            return socket.end(JSON.stringify({ok:false, error:'Unsupported native action'}) + '\n');
          // Reply preparation can initialize, resume and start a turn, each with
          // its own bounded RPC timeout. Let the backend report the outcome;
          // a five-second pipe timeout used to lose the acknowledgement.
          socket.setTimeout(request.command === 'send' ? 240000 : request.command==='logs'?240000:15000);
          const started=Date.now(),correlation={nativeSessionId,messageId:request.input?.messageId,sourceId:request.input?.sourceId,cardId:request.input?.id,taskKey:request.input?.taskKey};
          this.log?.write('native.command.started',{...correlation,method:request.command,phase:'native-command'},{context:null});
          try {
            const run=()=>this.command(request.command,request.input||{});
            const value = await (this.log?.scope?this.log.scope(correlation,run):run());
            this.log?.write('native.command.completed',{...correlation,method:request.command,elapsedMs:Date.now()-started,responseBytes:Buffer.byteLength(JSON.stringify(value)??'null')},{context:null});
            socket.end(JSON.stringify({ok:true, value}) + '\n');
          } catch (error) {
            const diagnosis=recovery(error);
            this.log?.write('native.command.failed',{...correlation,method:request.command,code:error.code,phase:error.phase,delivery:error.delivery,message:error.message,elapsedMs:Date.now()-started},{context:null});
            socket.end(JSON.stringify({ok:false, error:error.message,
              code:error.code, taskId:error.taskId, messageId:error.messageId, delivery:error.delivery,
              category:diagnosis.category,recovery:diagnosis.guidance}) + '\n');
          }
        } else if (request.method === 'status') {
          socket.end(JSON.stringify({ok:true, value:{...this.status(), cornerOwner:this.claimed?'native':'electron', pid:process.pid}}) + '\n');
        } else if (request.method === 'quitIfIdle') {
          if (this.status().activeWriters !== 0)
            return socket.end(JSON.stringify({ok:false, error:'A chat is still running'}) + '\n');
          this.maintenance=true;
          socket.end(JSON.stringify({ok:true}) + '\n', () => this.quit());
        } else socket.end(JSON.stringify({ok:false, error:'Unknown native control command'}) + '\n');
      });
    });
    try {
      await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.pipe, () => {this.server.removeListener('error', reject); resolve();});
      });
    this.server.on('error', () => {});
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    fs.writeFileSync(this.file, 'work-updates-native-v1\n' + this.pipe + '\n' + this.token + '\n' + process.pid + '\n', {mode:0o600});
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }
  sendState(socket, state) {
    const frame = JSON.stringify({event:'state', state}) + '\n';
    if (Buffer.byteLength(frame) > 2 * 1024 * 1024) {socket.destroy(); return;}
    this.log?.write('native.frame',{nativeSessionId:socket.diagnosticSession,frameBytes:Buffer.byteLength(frame)},{context:null});
    // One in-flight frame and one latest frame. Slow readers cannot accumulate
    // an unbounded history, and always receive the newest queue after draining.
    if (socket.writableNeedDrain) socket.latestState = frame;
    else socket.write(frame);
  }
  broadcast(state) {
    const serialized = JSON.stringify(state);
    if (serialized === this.lastState) return;
    this.lastState = serialized;
    for (const socket of this.subscribers) this.sendState(socket, state);
  }
  close() {
    this.owner = null;
    for (const socket of this.clients) socket.destroy();
    const endpointDirectory = this.endpointDirectory;
    const pipe = this.pipe;
    const cleanup = () => {
      if (!endpointDirectory) return;
      try {fs.unlinkSync(pipe);} catch (error) {if (error.code !== 'ENOENT') return;}
      try {fs.rmdirSync(endpointDirectory);} catch {}
    };
    if (this.server) this.server.close(cleanup);
    else cleanup();
    try {
      // Never remove the descriptor of a newer app instance.
      if (fs.readFileSync(this.file, 'utf8').split('\n')[2] === this.token) fs.unlinkSync(this.file);
    } catch {}
  }
}
module.exports = { NativeControl };
