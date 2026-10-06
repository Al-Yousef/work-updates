'use strict';
const fs=require('node:fs'),path=require('node:path');
const {CodexDesktop}=require('../src/codex-desktop.cjs');
const {DiagnosticLog}=require('../src/diagnostics.cjs');
const directory=path.resolve(__dirname,'../artifacts/desktop-owner-probe');
const client=new CodexDesktop({log:new DiagnosticLog(directory)});
(async()=>{try{
  const threadId=process.argv[2];if(!/^[a-f0-9-]{36}$/i.test(threadId||''))throw new Error('Provide the exact source chat UUID');
  const owner=await client.owner(threadId);const result={readOnly:true,connected:!!client.clientId,ownerFound:!!owner,threadId};
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{client.close();}})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
