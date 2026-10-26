import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {startEditor} from '../dist/editor/server.js';
import {findChrome} from '../dist/render.js';
const {chromium}=await import(process.env.DSH_DESIGN_PLAYWRIGHT?pathToFileURL(process.env.DSH_DESIGN_PLAYWRIGHT).href:'playwright-core');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-multiselect-browser-'));
await fs.cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),path.join(root,'canvas'),{recursive:true});
const server=await startEditor({workspaceDir:root});
const browser=await chromium.launch({executablePath:await findChrome(),headless:true});
try {
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const file=path.join(root,'canvas','Profile.dc.html'), original=await fs.readFile(file,'utf8');
  const ready=async()=>{await page.waitForFunction(()=>window.designEditor?.bridge()?.ready && window.designEditor?.features.selection);await page.waitForTimeout(200);};
  await page.goto(server.url);await ready();await page.locator('#zoom').selectOption('1');
  const frame=page.locator('#board').contentFrame();
  await frame.locator('#heading').click();await frame.locator('#subtitle').click({modifiers:['Shift']});
  assert.equal(await page.evaluate(()=>window.designEditor.features.selection.getSelection().length),2);
  assert.equal(await page.locator('[data-batch-prop="font-size"]').getAttribute('placeholder'),'多个值');
  assert.equal(await page.locator('#textBtn').isDisabled(),true);
  await page.locator('[data-batch-prop="border-radius"]').fill('12px');await page.locator('[data-batch-prop="border-radius"]').press('Tab');
  await page.waitForFunction(()=>!window.designEditor.features.selection.busy);await page.waitForTimeout(100);
  const modified=await fs.readFile(file,'utf8');assert.equal((modified.match(/border-radius: 12px/g)||[]).length,2);
  assert.match(modified,/font-size: 28px/);assert.match(modified,/font-size: 16px/);
  assert.equal(await page.evaluate(()=>window.designEditor.features.selection.getSelection().length),2);
  await page.locator('#undo').click();await ready();assert.equal(await fs.readFile(file,'utf8'),original);
  console.log('PASS multiselect click, common values, atomic save and undo');

  await frame.locator('#heading').click();await frame.locator('#subtitle').click({modifiers:['Shift']});
  const before=await frame.locator('#heading').boundingBox();
  await page.mouse.move(before.x+15,before.y+15);await page.mouse.down();await page.mouse.move(before.x+45,before.y+35,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>!window.designEditor.features.selection.busy);await page.waitForTimeout(150);
  const after=await frame.locator('#heading').boundingBox();assert.ok(Math.abs(after.x-before.x-30)<2);
  assert.equal((await fs.readFile(file,'utf8')).match(/translate\(30px, 20px\)/g).length,2);
  await page.locator('#undo').click();await ready();assert.equal(await fs.readFile(file,'utf8'),original);
  console.log('PASS group drag and byte-exact undo');

  await page.locator('#regionSelect').click();
  const heading=await frame.locator('#heading').boundingBox(),subtitle=await frame.locator('#subtitle').boundingBox();
  await page.mouse.move(heading.x-2,heading.y-2);await page.mouse.down();await page.mouse.move(subtitle.x+subtitle.width+2,subtitle.y+subtitle.height+2,{steps:5});await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.designEditor.features.selection.getSelection().length),2);
  await page.locator('#regionSelect').click();
  const snapshot=await fs.readFile(file,'utf8');
  await page.mouse.move(heading.x+12,heading.y+12);await page.mouse.down();await page.mouse.move(heading.x+42,heading.y+32,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await fs.readFile(file,'utf8'),snapshot);
  console.log('PASS actual pointer marquee and canceled group drag');

  await page.locator('#boards button',{hasText:'Repeated list'}).click();await ready();
  const repeated=await page.evaluate(()=>{
    const b=window.designEditor.bridge(),doc=document.querySelector('#board').contentDocument;
    const groups={};for(const node of doc.querySelectorAll('[data-dc-tpl]'))if(b.provenance(node).writable){const tid=node.getAttribute('data-dc-tpl');(groups[tid]??=[]).push(node);}
    const tid=Object.keys(groups).find(tid=>groups[tid].length>1);b.selectMany([{tid:Number(tid),instance:{index:0}},{tid:Number(tid),instance:{index:1}}]);return Number(tid);
  });
  assert.ok(Number.isInteger(repeated));assert.equal(await page.evaluate(()=>window.designEditor.features.selection.getSelection().length),2);
  await page.evaluate(()=>window.designEditor.features.selection.applyProperty('border-radius','7px'));
  const listSource=await fs.readFile(path.join(root,'canvas','List.dc.html'),'utf8');
  assert.equal((listSource.match(/border-radius: 7px/g)||[]).length,1);
  assert.deepEqual(errors,[]);
  console.log('PASS repeated instance selection and deduplicated batch write');
} finally {await browser.close();await server.close();await fs.rm(root,{recursive:true,force:true});}
