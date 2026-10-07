'use strict';
const { spawnSync } = require('node:child_process');
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['install','--ignore-scripts'],{cwd:require('node:path').resolve(__dirname,'..'),stdio:'inherit',shell:process.platform==='win32'});
process.exitCode=result.status || (result.error?1:0);
