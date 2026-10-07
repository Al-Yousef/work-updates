'use strict';
const fs=require('node:fs'),path=require('node:path');
const {UpdateTransaction}=require('../src/update-transaction.cjs');
const {windowsHooks}=require('./update-host.cjs');
async function main(args=process.argv.slice(2)){
  const get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing '+name);return path.resolve(args[i+1]);};
  const installRoot=get('--install-root'),dataDirectory=get('--data-dir'),packageDirectory=get('--package-dir'),sourceRoot=get('--source-root');
  const transaction=new UpdateTransaction({installRoot,dataDirectory,packageDirectory,sourceRoot,hooks:windowsHooks({installRoot,dataDirectory})});
  const result=args.includes('--recover')?await transaction.recover():await transaction.run(JSON.parse(fs.readFileSync(path.join(packageDirectory,'update-manifest.json'),'utf8')));
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(require.main===module)main().catch(e=>{process.stderr.write(e.message+(e.recovery?' Recovery: '+e.recovery:'')+'\n');process.exitCode=1;});
module.exports={main};
