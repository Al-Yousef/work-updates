'use strict';
const fs=require('node:fs');
const {UpdateTransaction}=require('../../src/update-transaction.cjs');
const [file,phase]=process.argv.slice(2),options=JSON.parse(fs.readFileSync(file));
// Abrupt installer exit tests persisted journal/files/ownership independently
// of backend health. Actual child readiness is exercised by update-profile.
const hooks={async assertIdle(){},async stop(){},async start(){},async launch(){}};
new UpdateTransaction({...options,hooks,checkpoint:p=>{if(p===phase)process.exit(85);}}).run(options.manifest).then(()=>process.exit(86)).catch(()=>process.exit(87));
