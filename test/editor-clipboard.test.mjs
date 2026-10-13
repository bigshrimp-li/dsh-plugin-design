import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { captureClipboard, pasteClipboard } from '../dist/editor/clipboard.js';
import { handleClipboard } from '../dist/editor/clipboard-routes.js';
import { createSourceRef, listElements } from '../dist/editor/source.js';
import { EditorTransactions, revisionOf } from '../dist/editor/transactions.js';
import { install } from '../src/editor/assets/clipboard.js';
const wrap=content=>`<x-dc><helmet><style>p{color:red}</style></helmet><div>${content}</div></x-dc>`;
function ref(source,id,canvas='one',board='Profile.dc.html') {
  const element=listElements(source).find(el=>el.attrs.some(a=>a.name==='id'&&a.value===id));assert.ok(element);
  return createSourceRef(source,{canvas,board},element.tid);
}
async function fixture(t,withAsset=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-clipboard-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const canvas of ['one','two'])await fs.cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),path.join(root,canvas),{recursive:true});
  const transactions=new EditorTransactions(),events=[];
  const ctx={workspace:root,transactions,origin:'test',canvasDir:canvas=>path.join(root,canvas),boardPath:(dir,board)=>path.join(dir,board),broadcast:event=>events.push(event)};
  const read=(canvas,board='Profile.dc.html')=>fs.readFile(path.join(root,canvas,board),'utf8');
  let asset;
  if(withAsset) {
    const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
    const id=createHash('sha256').update(bytes).digest('hex').slice(0,32);asset={id,bytes,file:`assets/${id}.svg`};
    await fs.mkdir(path.join(root,'one','assets'),{recursive:true});await fs.writeFile(path.join(root,'one',asset.file),bytes);await fs.writeFile(path.join(root,'one','assets/index.json'),JSON.stringify({[id]:'image/svg+xml'}));
    const source=await read('one');await fs.writeFile(path.join(root,'one','Profile.dc.html'),source.replace(/<p id="literal"[^>]*>[^<]*<\/p>/,`<section id="clip"><img src="/_blob/${id}" alt="test"></section>`));
  }
  const copy=async (id=withAsset?'clip':'literal',cut=false)=>{const source=await read('one');const body={canvas:'one',board:'Profile.dc.html',revision:revisionOf(source),sourceRef:ref(source,id),cut};return {body,result:await handleClipboard('/api/clipboard/copy',body,ctx)};};
  const paste=async(payload,canvas='one',board='Profile.dc.html',sourceRef=null)=>{const before=await read(canvas,board);return handleClipboard('/api/clipboard/paste',{canvas,board,revision:revisionOf(before),sourceRef,payload},ctx);};
  return {root,ctx,transactions,events,read,copy,paste,asset};
}
test('same board, same canvas and cross-canvas pastes share correct focus and exact undo/redo',async t=>{
  const f=await fixture(t,true);const {result}=await f.copy();
  for(const [canvas,board] of [['one','Profile.dc.html'],['one','Layout.dc.html'],['two','Profile.dc.html']]) {
    const before=await f.read(canvas,board);const out=await f.paste(result.payload,canvas,board);
    const after=await f.read(canvas,board);assert.equal(out.canvas,canvas);assert.equal(out.board,board);
    const focus=listElements(after)[out.focusTid];assert.equal(focus.tag,'section');assert.ok(focus.attrs.some(a=>a.name==='id'&&a.value.startsWith('clip-copy')));
    assert.equal(f.transactions.status(path.join(f.root,canvas)).undoCount,1);
    if(canvas==='two'){assert.ok(out.files.includes(f.asset.file));assert.deepEqual(await fs.readFile(path.join(f.root,canvas,f.asset.file)),f.asset.bytes);}
    await f.transactions.undo(path.join(f.root,canvas));assert.equal(await f.read(canvas,board),before);
    if(canvas==='two')await assert.rejects(fs.readFile(path.join(f.root,canvas,f.asset.file)),{code:'ENOENT'});
    await f.transactions.redo(path.join(f.root,canvas));assert.equal(await f.read(canvas,board),after);
    await f.transactions.undo(path.join(f.root,canvas));
  }
});
test('cut writes only deletion after copy succeeds; paste and cut remain separate reversible records',async t=>{
  const f=await fixture(t),original=await f.read('one');const {body,result}=await f.copy('literal',true);
  assert.equal(await f.read('one'),original);assert.equal(f.transactions.status(path.join(f.root,'one')).undoCount,0);
  await assert.rejects(handleClipboard('/api/clipboard/cut',{...body,payload:result.payload},f.ctx),/确认/);assert.equal(await f.read('one'),original);
  const cut=await handleClipboard('/api/clipboard/cut',{...body,payload:result.payload,confirmation:result.cut.confirmation},f.ctx);
  assert.deepEqual(cut.files,['Profile.dc.html']);assert.ok(!(await f.read('one')).includes('id="literal"'));
  await f.paste(result.payload);assert.equal(f.transactions.status(path.join(f.root,'one')).undoCount,2);
  await f.transactions.undo(path.join(f.root,'one'));assert.ok(!(await f.read('one')).includes('id="literal-copy"'));
  await f.transactions.undo(path.join(f.root,'one'));assert.equal(await f.read('one'),original);
});
test('CSS, binding, event, component, ID and navigation dependencies reject with actionable reasons',()=>{
  const cases=[
    ['<p id="source" class="special">Text</p>','<p>Target</p>',/CSS/,'different'],
    ['<p id="source">{{item.name}}</p>','<p>Target</p>',/绑定/],
    ['<button id="source" onclick="{{go}}">Go</button>','<p>Target</p>',/事件/],
    ['<label id="source" for="missing">Name</label>','<p>Target</p>',/#missing/],
    ['<a id="source" href="Missing.dc.html">Next</a>','<p>Target</p>',/导航画板/],
  ];
  for(const [content,dest,pattern,different] of cases) {
    const source=wrap(content),snapshot=captureClipboard(source,ref(source,'source'));
    const destination=different?wrap(dest).replace('color:red','color:blue'):wrap(dest);
    assert.throws(()=>pasteClipboard(destination,snapshot,{canvas:'one',board:'Other.dc.html',boards:['Other.dc.html']}),pattern);
  }
  const component=wrap('<section id="source"><dc-import path="Other.dc.html"></dc-import></section>');
  assert.throws(()=>captureClipboard(component,ref(component,'source')),/组件/);
});
test('nested board links rebase correctly and local references share collision-safe IDs',()=>{
  const source=wrap('<section id="source"><label for="field">Name</label><input id="field"><a href="../Target.dc.html">Next</a></section>');
  const snapshot=captureClipboard(source,ref(source,'source','one','nested/Source.dc.html'));
  const destination=wrap('<p id="field-copy">Existing</p>');
  const out=pasteClipboard(destination,snapshot,{canvas:'two',board:'deep/nested/Dest.dc.html',boards:['Target.dc.html','deep/nested/Dest.dc.html']});
  assert.match(out.source,/href="..\/..\/Target.dc.html"/);assert.match(out.source,/for="field-copy-2"/);assert.match(out.source,/id="field-copy-2"/);
});
test('tampered/unknown clipboard and missing/hash-conflicting resources leave no edits',async t=>{
  const f=await fixture(t,true),before=await f.read('two'),{result}=await f.copy();
  await assert.rejects(f.paste({...result.payload,fragment:'<script>bad</script>'},'two'),/修改/);
  await assert.rejects(f.paste({kind:'deepseek-design-fragment',token:'external'},'two'),/过期/);
  await fs.rm(path.join(f.root,'one',f.asset.file));await assert.rejects(f.paste(result.payload,'two'),/缺失/);
  await fs.writeFile(path.join(f.root,'one',f.asset.file),'changed');await assert.rejects(f.paste(result.payload,'two'),/标识/);
  assert.equal(await f.read('two'),before);assert.equal(f.transactions.status(path.join(f.root,'two')).undoCount,0);
  await assert.rejects(fs.readFile(path.join(f.root,'two',f.asset.file)),{code:'ENOENT'});
});
test('existing equal assets are reused and undo never removes externally referenced resources',async t=>{
  const f=await fixture(t,true),{result}=await f.copy();
  await fs.mkdir(path.join(f.root,'two','assets'),{recursive:true});await fs.writeFile(path.join(f.root,'two',f.asset.file),f.asset.bytes);
  const out=await f.paste(result.payload,'two');assert.ok(!out.files.includes(f.asset.file));
  await f.transactions.undo(path.join(f.root,'two'));assert.deepEqual(await fs.readFile(path.join(f.root,'two',f.asset.file)),f.asset.bytes);
  await fs.rm(path.join(f.root,'two',f.asset.file));await f.paste(result.payload,'two');
  const other=await f.read('two','Layout.dc.html');await fs.writeFile(path.join(f.root,'two','Layout.dc.html'),other.replace('</div>\n</x-dc>',`<img src="/_blob/${f.asset.id}" alt="external"></div>\n</x-dc>`));
  await assert.rejects(f.transactions.undo(path.join(f.root,'two')),{status:422});assert.deepEqual(await fs.readFile(path.join(f.root,'two',f.asset.file)),f.asset.bytes);
  assert.equal(f.transactions.status(path.join(f.root,'two')).canUndo,true);
});
test('mid-install I/O failure rolls back board and only newly owned assets',async t=>{
  const f=await fixture(t,true),{result}=await f.copy(),before=await f.read('two');
  const originalLink=fs.link;let injected=false,partialInstallObserved=false;
  const targetRoot=await fs.realpath(path.join(f.root,'two'));
  fs.link=async (from,to)=>{if(String(to)===path.join(targetRoot,'assets/index.json')&&!injected){
    injected=true;
    partialInstallObserved=(await f.read('two'))!==before && (await fs.readFile(path.join(targetRoot,f.asset.file))).equals(f.asset.bytes);
    const error=new Error('simulated disk failure');error.code='EIO';throw error;
  }return originalLink(from,to);};
  try{await assert.rejects(f.paste(result.payload,'two'),/simulated disk failure/);}finally{fs.link=originalLink;}
  assert.equal(injected,true);assert.equal(partialInstallObserved,true,'failure must occur after board and asset installation');assert.equal(await f.read('two'),before);await assert.rejects(fs.readFile(path.join(f.root,'two',f.asset.file)),{code:'ENOENT'});
  assert.equal(f.transactions.status(path.join(f.root,'two')).undoCount,0);
});
test('system clipboard fallback is labelled; unrelated system content never silently uses cache; text/IME shortcuts pass through',async()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let readText=async()=>'{"kind":"other"}';const notices=[],calls=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw new Error('denied');},readText:()=>readText()}}});
  try {
    const sourceRef={canvas:'one',board:'Profile.dc.html',revision:'rev',tid:3};
    const payload={kind:'deepseek-design-fragment',version:1,token:'token'};
    const editor={state:{canvas:'one',board:'Profile.dc.html',revision:'rev',selectedTid:3},features:{},bridge:()=>({describe:()=>({sourceRef,writable:true}),getSelection:()=>[{sourceRef}]}),beforeAction:async()=>{},addButton(){},registerInspector(){},registerShortcut(fn){this.shortcut=fn;},toast:(...args)=>notices.push(args),acceptMutation:async()=>{},post:async(url,body)=>{calls.push(url);return url.endsWith('copy')?{payload,sourceLabel:'one/Profile.dc.html',createdAt:'2026-10-13T00:00:00Z'}:{files:['Profile.dc.html'],focusTid:4};}};
    install(editor);await editor.features.clipboard.copy();assert.equal(editor.features.clipboard.internal.system,false);assert.match(notices.at(-1)[0],/内部备用：one\/Profile/);
    await assert.rejects(editor.features.clipboard.paste(),/不是编辑器源码片段/);assert.deepEqual(calls,['/api/clipboard/copy']);
    await editor.features.clipboard.paste({internal:true});assert.equal(calls.at(-1),'/api/clipboard/paste');
    for(const patch of [{isComposing:true},{target:{closest:()=>({})}},{altKey:true},{shiftKey:true}])assert.equal(editor.shortcut({key:'c',ctrlKey:true,target:{},...patch}),false);
  }finally{if(saved)Object.defineProperty(globalThis,'navigator',saved);else delete globalThis.navigator;}
});


test('cut preflight keeps unsupported event subtrees and externally referenced ids on disk',async t=>{
  const f=await fixture(t),original=await f.read('one');
  await assert.rejects(f.copy('counter',true),/事件|脚本/);
  assert.equal(await f.read('one'),original);
  const referenced=original.replace('<input id="name"','<label for="name">Name</label><input id="name"');
  await fs.writeFile(path.join(f.root,'one','Profile.dc.html'),referenced);
  await assert.rejects(f.copy('name',true),/子树外/);
  assert.equal(await f.read('one'),referenced);
  assert.equal(f.transactions.status(path.join(f.root,'one')).undoCount,0);
});
test('identical relative stylesheet hrefs do not prove cross-canvas class dependencies',()=>{
  const source=wrap('<p id="source" class="brand">Text</p>').replace('<helmet>','<helmet><link rel="stylesheet" href="./ds/theme/tokens.css">');
  const destination=wrap('<p>Target</p>').replace('<helmet>','<helmet><link rel="stylesheet" href="./ds/theme/tokens.css">');
  const snapshot=captureClipboard(source,ref(source,'source'));
  assert.throws(()=>pasteClipboard(destination,snapshot,{canvas:'two',board:'Other.dc.html',boards:['Other.dc.html']}),/外部样式表/);
});
