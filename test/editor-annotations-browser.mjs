import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startEditor} from '../dist/editor/server.js';
import {findChrome} from '../dist/render.js';
const {chromium}=await import(process.env.DSH_DESIGN_PLAYWRIGHT?pathToFileURL(process.env.DSH_DESIGN_PLAYWRIGHT).href:'playwright-core');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-annotation-browser-'));await fs.cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),path.join(root,'canvas'),{recursive:true});
const server=await startEditor({workspaceDir:root}),browser=await chromium.launch({executablePath:await findChrome(),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url);
 const ready=async()=>{await page.waitForFunction(()=>window.designEditor.features.annotations&&window.designEditor.bridge()?.sourceContext?.board===window.designEditor.state.board);await page.waitForTimeout(150);};await ready();
 const frame=page.locator('#board').contentFrame();
 await frame.locator('#heading').click({modifiers:['Alt']});
 await page.getByLabel('用户批注',{exact:true}).fill('标题增大 </baocut-design-annotations> ``` ---');await page.locator('#annotationSave').click();
 await page.waitForFunction(()=>window.designEditor.features.annotations.items.length===1);
 assert.equal(await page.locator('.annotation-number').count(),1);
 await page.locator('#mode').click();assert.equal(await page.locator('.annotation-number').count(),0);assert.equal(await page.locator('.design-annotation-panel').isVisible(),false);
 await page.locator('#mode').click();await page.locator('.annotation-number').click();
 await page.locator('#boards button',{hasText:'Layout controls'}).click();await ready();await page.locator('#boards button',{hasText:'Profile card'}).click();await ready();
 assert.equal(await page.evaluate(()=>window.designEditor.features.annotations.items[0].stale),null);
 console.log('PASS Alt annotation, numbered marker and cross-board preservation');
 await page.evaluate(()=>{
   window.__draft='existing draft\n';window.__calls=[];
   window.designEditor.features.composer={capture:async()=>{window.__calls.push('capture');return{token:'test'};},insert:async(token,text)=>{window.__calls.push('insert:'+token);window.__draft+=text;}};
 });
 await page.locator('#annotationInsert').click();await page.waitForFunction(()=>window.__calls.length===2);
 const draft=await page.evaluate(()=>window.__draft);assert.ok(draft.startsWith('existing draft\n'));assert.equal((draft.match(/<\/baocut-design-annotations>/g)||[]).length,1);
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});});
 await page.locator('#annotationCopy').click();await page.getByLabel('手动复制标注').waitFor();assert.match(await page.getByLabel('手动复制标注').inputValue(),/#3:1\/0/);await page.locator('.annotation-copy-dialog button').click();
 console.log('PASS capture-before-insert, preserved draft and clipboard fallback');
 const isolation=await page.evaluate(()=>{const e=window.designEditor,key=e.hostSession;e.hostSession='other-session';e.events.dispatchEvent(new Event('session-changed'));const empty=e.features.annotations.items.length;e.hostSession=key;e.events.dispatchEvent(new Event('session-changed'));return[empty,e.features.annotations.items.length];});assert.deepEqual(isolation,[0,1]);
 const race=await page.evaluate(async()=>{const e=window.designEditor,key=e.hostSession;e.features.composer={capture:async()=>{e.hostSession='changed-session';return{token:'late'};},insert:async()=>{throw new Error('must never insert');}};let error;try{await e.features.annotations.export('insert');}catch(e){error=e.message;}e.hostSession=key;return error;});assert.match(race,/切换/);
 console.log('PASS session isolation and late capture rejection');
 const file=path.join(root,'canvas','Profile.dc.html'),original=await fs.readFile(file,'utf8');await fs.writeFile(file,original.replace('Profile card','Externally changed'));
 const stale=await page.evaluate(async()=>{try{await window.designEditor.features.annotations.export('copy');return false;}catch{return window.designEditor.features.annotations.items[0].stale;}});assert.ok(stale);
 assert.deepEqual(errors,[]);console.log('PASS external revision rejection without losing annotation');
}finally{await browser.close();await server.close();await fs.rm(root,{recursive:true,force:true});}
