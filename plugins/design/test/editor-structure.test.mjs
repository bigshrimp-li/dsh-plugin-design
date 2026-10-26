import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planStructure } from '../dist/editor/structure.js';
import { handleStructure } from '../dist/editor/structure-routes.js';
import { createSourceRef, listElements } from '../dist/editor/source.js';
import { EditorTransactions, revisionOf } from '../dist/editor/transactions.js';
const wrap = contents => `<x-dc><helmet><style>p{color:red}</style></helmet><div>${contents}</div></x-dc>`;
const request=(source,id,action,options={})=>{
  const el=listElements(source).find(e=>e.attrs.some(a=>a.name==='id'&&a.value===id));
  assert.ok(el,`fixture element ${id}`);
  return {canvas:'canvas',board:'Profile.dc.html',revision:revisionOf(source),sourceRef:createSourceRef(source,{canvas:'canvas',board:'Profile.dc.html'},el.tid),action,...options};
};
test('structural operation table preserves unaffected bytes and returns server-derived focus',()=>{
  const source=wrap('\n  <div id="a"><p>One</p></div>\n  <div id="b"><span id="child">Two</span></div>\n  <p id="c">Three</p>\n');
  for(const [id,action,options,tag,check] of [
    ['b','delete',{},'div',s=>!s.includes('id="b"')],
    ['b','duplicate',{},'div',s=>s.includes('id="b-copy"')&&s.includes('id="child-copy"')],
    ['b','up',{},'div',s=>s.indexOf('id="b"')<s.indexOf('id="a"')],
    ['b','down',{},'div',s=>s.indexOf('id="b"')>s.indexOf('id="c"')],
    ['b','indent',{},'div',s=>/<div id="a"><p>One<\/p><div id="b">/.test(s)],
    ['child','outdent',{},'span',s=>/<div id="b"><\/div><span id="child">/.test(s)],
    ['b','wrap-flex',{},'div',s=>s.includes('display: flex; flex-direction: column')],
    ['b','wrap-grid',{},'div',s=>s.includes('display: grid; grid-template-columns: 1fr')],
    ['a','insert',{kind:'text',text:'<literal & text>'},'p',s=>s.includes('&lt;literal &amp; text&gt;')],
    ['a','insert',{kind:'rect'},'div',s=>s.includes('width: 120px')],
    ['a','insert',{kind:'divider'},'hr',s=>s.includes('<hr')],
    ['a','insert',{kind:'image',asset:'0123456789abcdef0123456789abcdef'},'img',s=>s.includes('/_blob/0123456789abcdef0123456789abcdef')],
  ]) {
    const plan=planStructure(source,request(source,id,action,options));
    assert.equal(plan.changed,true,action);assert.equal(check(plan.source),true,action);
    assert.equal(listElements(plan.source)[plan.focusTid].tag,tag,action);
    assert.ok(plan.source.startsWith('<x-dc><helmet><style>p{color:red}</style></helmet>'));
    assert.ok(!plan.source.includes('data-dsh-structure-focus'));
    assert.equal(plan.confirmation,planStructure(source,request(source,id,action,options)).confirmation,'deterministic confirmation');
  }
});
test('range edits preserve adjacent comments and mixed text; ambiguous moves refuse',()=>{
  const source=wrap('before<!--before--><span id="a">A <b>bold</b> B</span><!--after-->after<span id="b">B</span>');
  const removed=planStructure(source,request(source,'a','delete')).source;
  assert.equal(removed,wrap('before<!--before--><!--after-->after<span id="b">B</span>'));
  const copied=planStructure(source,request(source,'a','duplicate')).source;
  assert.match(copied,/<span id="a-copy">A <b>bold<\/b> B<\/span><!--after-->after/);
  assert.throws(()=>planStructure(source,request(source,'a','down')),/文字或注释/);
});
test('actual root, void parent, metadata, invalid nesting, and scope escape are protected',()=>{
  for(const [contents,id,action,options,pattern] of [
    ['<p id="p">Text</p>','p','insert',{kind:'rect'},/行内/],
    ['<img id="img" src="/_blob/0123456789abcdef0123456789abcdef">','img','insert',{kind:'text'},/容器/],
    ['<ul><li id="li">X</li></ul>','li','wrap-flex',{},/不能/],
    ['<div id="prev"></div><sc-for list="{{items}}" as="item"><p id="item">{{item.name}}</p></sc-for>','item','outdent',{},/作用域/],
    ['<div id="unsafe"><dc-import path="Other.dc.html"></dc-import></div>','unsafe','delete',{},/组件/],
  ]) {const source=wrap(contents);assert.throws(()=>planStructure(source,request(source,id,action,options)),pattern);}
  const source='<x-dc><!-- first --><helmet><style>p{}</style></helmet><main id="root"><p>Text</p></main></x-dc>';
  assert.throws(()=>planStructure(source,request(source,'root','delete')),/实际根/);
  assert.throws(()=>planStructure(source,request(source,'root','duplicate')),/实际根/);
  assert.equal(planStructure(source,request(source,'root','insert',{kind:'text'})).changed,true);
});
test('local IDs and references rewrite together; ambiguous script and duplicate IDs refuse',()=>{
  const source=wrap('<section id="group"><label for="field" aria-controls="field label">Name</label><input id="field"><span id="label"></span><a href="#field">Link</a></section>');
  const after=planStructure(source,request(source,'group','duplicate')).source;
  assert.match(after,/for="field-copy" aria-controls="field-copy label-copy"/);assert.match(after,/href="#field-copy"/);
  for(const contents of ['<div id="a"><span id="same"></span><span id="same"></span></div>','<button id="a" onClick="{{fn}}">X</button>']) {
    const src=wrap(contents);assert.throws(()=>planStructure(src,request(src,'a','duplicate')),/id|事件|脚本/);
  }
  const scripted=wrap('<div id="a">A</div>')+'<script>document.getElementById("a")</script>';
  assert.throws(()=>planStructure(scripted,request(scripted,'a','duplicate')),/引用/);
});
test('scope effects and layout hazards are surfaced before commit',()=>{
  const source=wrap('<sc-for list="{{items}}" as="item"><p id="item">{{item.name}}</p></sc-for>');
  const plan=planStructure(source,request(source,'item','duplicate'));assert.match(plan.warnings.join(''),/全部实例/);
  for(const style of ['position: relative','transform: rotate(2deg)','z-index: 2']) {
    const src=wrap(`<p id="item" style="${style}">X</p>`);assert.throws(()=>planStructure(src,request(src,'item','wrap-flex')),/定位|层叠/);
  }
  assert.throws(()=>planStructure(source,{...request(source,'item','delete'),revision:'stale'}),/版本/);
});
test('preview/cancel writes nothing; every operation is one byte-exact undoable history entry',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-structure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'canvas');await fs.cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),dir,{recursive:true});
  const file=path.join(dir,'Profile.dc.html'), original=await fs.readFile(file,'utf8');
  const source=original.replace(/<x-dc>[\s\S]*?<\/x-dc>/,wrap('\n<div id="a"><p>One</p></div>\n<div id="b"><span id="child">Two</span></div>\n<p id="c">Three</p>\n'));
  await fs.writeFile(file,source);
  const tx=new EditorTransactions();const events=[];
  const ctx={workspace:root,canvasDir:()=>dir,boardPath:(d,b)=>path.join(d,b),transactions:tx,broadcast:event=>events.push(event),origin:'test'};
  for(const [id,action,options] of [['b','delete',{}],['b','duplicate',{}],['b','up',{}],['b','down',{}],['b','indent',{}],['child','outdent',{}],['b','wrap-flex',{}],['b','wrap-grid',{}],['a','insert',{kind:'text'}],['a','insert',{kind:'rect'}],['a','insert',{kind:'divider'}]]) {
    const body=request(source,id,action,options);
    const preview=await handleStructure('/api/structure/preview',body,ctx);
    assert.equal(await fs.readFile(file,'utf8'),source);assert.equal(tx.status(dir).undoCount,0);
    await assert.rejects(handleStructure('/api/structure',body,ctx),{code:'preview_required'});
    const result=await handleStructure('/api/structure',{...body,confirmation:preview.confirmation},ctx);
    assert.equal(result.canUndo,true);assert.equal(result.history.undoCount,1);assert.equal(result.focusTid,preview.focusTid);
    assert.equal(await fs.readFile(file,'utf8'),preview.source);
    await tx.undo(dir);assert.equal(await fs.readFile(file,'utf8'),source);
  }
  const body=request(source,'b','delete'),preview=await handleStructure('/api/structure/preview',body,ctx);
  await fs.writeFile(file,source+'\n<!-- external -->');
  await assert.rejects(handleStructure('/api/structure',{...body,confirmation:preview.confirmation},ctx),{status:409});
  assert.equal(await fs.readFile(file,'utf8'),source+'\n<!-- external -->');
  assert.equal(events.length,11);
});
