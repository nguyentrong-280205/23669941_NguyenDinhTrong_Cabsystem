'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const children=[]; let stopping=false;
for (const service of ['identity','customer','driver','booking','trip','payment','notification','gateway']) {
  const child=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(__dirname,`../services/${service}`),stdio:'inherit',shell:false}); children.push(child);
  child.once('error',()=>stop(1)); child.once('exit',code=>{if (!stopping) { console.error(`${service} stopped unexpectedly`); stop(code || 1); }});
}
function stop(code=0) { if (stopping) return; stopping=true; const pending=children.map(child=>new Promise(resolve=>{ if (child.exitCode!==null) return resolve(); child.once('exit',resolve); child.kill('SIGTERM'); })); Promise.all(pending).then(()=>process.exit(code)); }
process.once('SIGTERM',()=>stop()); process.once('SIGINT',()=>stop());
