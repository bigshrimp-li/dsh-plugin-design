// Integration checks for the standalone DOM engine, served by the real plugin server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startEditor } from '../dist/editor/server.js';
import { findChrome } from '../dist/render.js';
import { listElements } from '../dist/editor/source.js';
import { exportCanvas } from '../dist/export.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-runtime-'));
const canvas = path.join(root, 'runtime');
await fs.mkdir(path.join(canvas, 'parts'), { recursive: true });
const board = (markup, logic, props = {}) => `<!doctype html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body><x-dc>${markup}</x-dc><script type="text/x-dc" data-dc-script data-props='${JSON.stringify({$preview:{width:520,height:560},...props})}'>class Component extends DCLogic {${logic}}</script></body></html>`;
const source = board(`<helmet><style>body{margin:0}.accent{color:rgb(12,34,56)}</style></helmet>
<div id="root" style="width:520px;height:560px"><h1 id="title" class="accent">{{title}}</h1>
<input id="text" value="{{value}}" onChange="{{edit}}"><button id="inc" onClick="{{increment}}">{{count}}</button>
<input id="free"><input id="check" type="checkbox" checked="{{checked}}" onChange="{{toggle}}">
<select id="select" value="{{choice}}" onChange="{{choose}}"><option value="a">A</option><option value="b">B</option></select>
<button id="reverse" onClick="{{reverse}}">Reverse</button><button id="show" onClick="{{show}}">Show/hide</button>
<sc-if value="{{visible}}"><p id="conditional">Visible</p></sc-if>
<div id="items"><sc-for list="{{items}}" as="item" key="{{item.id}}"><input data-item="{{item.id}}" defaultValue="{{item.label}}"></sc-for></div>
<table><tbody><sc-for list="{{items}}" as="row"><tr><td>{{row.label}}</td></tr></sc-for></tbody></table>
<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="20"></circle></svg>
<dc-import name="parts/Child" label="{{value}}"></dc-import><dc-import name="parts/Child" label="Second"></dc-import>
</div>`, `componentDidMount(){window.mounts=(window.mounts||0)+1}
componentWillUnmount(){window.unmounts=(window.unmounts||0)+1}
renderVals(){const s=this.state;return {title:this.props.title,value:s.value||'',count:s.count||0,visible:!s.hidden,checked:!!s.checked,choice:s.choice||'a',items:s.items||[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}],edit:e=>this.setState({value:e.target.value}),increment:()=>this.setState(p=>({count:(p.count||0)+1})),toggle:e=>this.setState({checked:e.target.checked}),choose:e=>this.setState({choice:e.target.value}),reverse:()=>this.setState({items:(s.items||[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]).slice().reverse()}),show:()=>this.setState({hidden:!s.hidden})}}`, {title:{editor:'text',default:'Local <design> & friends'}});
const child = board('<div class="child"><span>{{label}}</span><button class="child-count" onClick="{{inc}}">{{count}}</button></div>', 'renderVals(){return {label:this.props.label,count:this.state.count||0,inc:()=>this.setState(p=>({count:(p.count||0)+1}))}}');
await fs.writeFile(path.join(canvas, 'Main.dc.html'), source);
await fs.writeFile(path.join(canvas, 'parts/Child.dc.html'), child);
await fs.writeFile(path.join(canvas, 'canvas.json'), JSON.stringify({v:3,createdOnFiles:{v:1},boards:{'Main.dc.html':{x:0,y:0,w:520,h:560},'parts/Child.dc.html':{x:600,y:0,w:520,h:560}},order:['Main.dc.html','parts/Child.dc.html'],notes:{},designSystems:[]}));
const server = await startEditor({workspaceDir:root});
const browser = await chromium.launch({executablePath:await findChrome(),headless:true});
const page = await browser.newPage();
let passed = 0;
const check = async (label, action) => { await action(); console.log('PASS', label); passed++; };
const url = new URL('/board/runtime/Main.dc.html?preview=1', server.url).href;
const network = [], errors = [];
page.on('request', r=>{if(/^https?:/.test(r.url()) && !r.url().startsWith(new URL(server.url).origin)) network.push(r.url())});
page.on('pageerror', e=>errors.push(e.message));
try {
  await page.goto(url); await page.waitForSelector('#dc-root #title');
  await check('text, defaults, helmet and zero framework/network imports', async()=>{
    assert.equal(await page.locator('#title').textContent(),'Local <design> & friends');
    assert.equal(await page.locator('#title').evaluate(e=>getComputedStyle(e).color),'rgb(12, 34, 56)');
    assert.equal(await page.evaluate(()=>typeof window.React),'undefined');
    assert.deepEqual(network,[]);
  });
  await check('controlled input keeps DOM identity, focus and caret during updates',async()=>{
    await page.locator('#text').fill('abc');
    await page.locator('#text').evaluate(e=>{window.inputBefore=e;e.setSelectionRange(1,1)});
    await page.keyboard.type('Z');
    assert.equal(await page.locator('#text').inputValue(),'aZbc');
    assert.equal(await page.evaluate(()=>window.inputBefore===document.activeElement && inputBefore.selectionStart===2),true);
  });
  await check('uncontrolled input survives unrelated state changes',async()=>{
    await page.locator('#free').fill('draft'); await page.locator('#inc').click();
    assert.equal(await page.locator('#inc').textContent(),'1'); assert.equal(await page.locator('#free').inputValue(),'draft');
  });
  await check('native checkbox and select event/value semantics',async()=>{
    await page.locator('#check').check(); await page.locator('#select').selectOption('b');
    await page.locator('#inc').click();
    assert.equal(await page.locator('#check').isChecked(),true); assert.equal(await page.locator('#select').inputValue(),'b');
  });
  await check('keyed lists preserve edited input when order changes',async()=>{
    await page.locator('[data-item=a]').fill('kept'); await page.locator('#reverse').click();
    assert.equal(await page.locator('#items input').first().getAttribute('data-item'),'b');
    assert.equal(await page.locator('[data-item=a]').inputValue(),'kept');
  });
  await check('conditional children unmount and remount',async()=>{
    await page.locator('#show').click(); assert.equal(await page.locator('#conditional').count(),0);
    await page.locator('#show').click(); assert.equal(await page.locator('#conditional').count(),1);
  });
  await check('table/select template hierarchy and SVG attributes survive HTML parsing',async()=>{
    assert.equal(await page.locator('tbody tr').count(),2);
    assert.equal(await page.locator('svg').getAttribute('viewBox'),'0 0 100 100');
    assert.equal(await page.locator('circle').evaluate(e=>e.namespaceURI),'http://www.w3.org/2000/svg');
  });
  await check('source IDs match editor parser and component hosts stay distinct',async()=>{
    const expected = listElements(source);
    const actual = await page.locator('#dc-root > .sc-host [data-dc-tpl]').evaluateAll(es=>es.filter(e=>e.closest('[data-design-host]').dataset.designHost==='root').map(e=>({tid:Number(e.dataset.dcTpl),tag:e.tagName.toLowerCase()})));
    for (const node of actual) assert.equal(expected[node.tid].tag,node.tag);
    assert.equal(await page.locator('#dc-root > .sc-host > #root > .sc-host').count(),2);
  });
  await check('imported instances isolate state and receive updated props',async()=>{
    await page.locator('.child-count').first().click();
    assert.deepEqual(await page.locator('.child-count').allTextContents(),['1','0']);
    assert.equal(await page.locator('.child span').first().textContent(),'aZbc');
  });
  await check('setProps and lifecycle do not remount root',async()=>{
    await page.evaluate(()=>window.__designRuntime.setProps({title:'Updated'}));
    await page.waitForFunction(()=>document.querySelector('#title').textContent==='Updated');
    assert.equal(await page.evaluate(()=>window.mounts),1);
    assert.deepEqual(await page.evaluate(()=>window.__designRuntime.errors),[]);
  });
  await check('standalone export embeds nested imports and works fully offline',async()=>{
    const exported = await exportCanvas({canvasDir:canvas,outDir:path.join(root,'output')});
    const offline = await browser.newContext({offline:true}); const tab = await offline.newPage();
    const requests=[];tab.on('request',r=>requests.push(r.url()));
    await tab.goto(pathToFileURL(exported.files[0].html).href); await tab.waitForSelector('.child-count');
    await tab.locator('.child-count').first().click();
    assert.deepEqual(await tab.locator('.child-count').allTextContents(),['1','0']);
    assert.ok(requests.every(u=>u.startsWith('file:')));
    assert.deepEqual(await tab.evaluate(()=>window.__designRuntime.errors),[]);
    await offline.close();
  });
  await check('unsupported imports and circular components fail visibly without network fallback',async()=>{
    const bad = await browser.newPage();
    await fs.writeFile(path.join(canvas,'Unsupported.dc.html'),board('<x-import name="ReactCard"></x-import>','renderVals(){return {}}'));
    await bad.goto(new URL('/board/runtime/Unsupported.dc.html?preview=1',server.url).href);
    await bad.waitForSelector('[data-design-error]');
    assert.match(await bad.locator('[data-design-error]').textContent(),/x-import/);
    await fs.writeFile(path.join(canvas,'Cycle.dc.html'),board('<dc-import name="Cycle"></dc-import>','renderVals(){return {}}'));
    await bad.goto(new URL('/board/runtime/Cycle.dc.html?preview=1',server.url).href);
    await bad.waitForSelector('[data-design-error]');
    assert.match(await bad.locator('[data-design-error]').textContent(),/Circular/);
    await bad.close();
  });
  await check('dispose releases DOM and lifecycle',async()=>{
    await page.evaluate(()=>window.__designRuntime.dispose());
    assert.equal(await page.locator('#dc-root').count(),0); assert.equal(await page.evaluate(()=>window.unmounts),1);
  });
  assert.deepEqual(errors,[]);
  console.log(`${passed}/${passed} runtime integration cases passed`);
} finally { await browser.close();await server.close();await fs.rm(root,{recursive:true,force:true}); }
