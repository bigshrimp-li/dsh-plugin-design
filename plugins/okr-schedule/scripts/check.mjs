import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
async function check(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await check(file);else if(/\.m?js$/.test(file)){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}}}
for(const file of ['index.js','client.js']){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
await check('src');await check('bin');await check('scripts');
