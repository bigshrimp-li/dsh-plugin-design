import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {commonValues} from '../src/editor/assets/selection.js';
import {handleMultiSelect} from '../dist/editor/multiselect-routes.js';
import {EditorTransactions,revisionOf} from '../dist/editor/transactions.js';
import {createSourceRef,listElements} from '../dist/editor/source.js';

test('common inline values distinguish unset, equal and mixed without computed styles',()=>{
  assert.deepEqual(commonValues([{inline:{}},{inline:{}}],'color'),{kind:'unset',value:''});
  assert.deepEqual(commonValues([{inline:{color:'red'}},{inline:{color:'red'}}],'color'),{kind:'same',value:'red'});
  assert.deepEqual(commonValues([{inline:{color:'red'}},{inline:{}}],'color'),{kind:'mixed',value:''});
  assert.deepEqual(commonValues([{inline:{color:'red'}},{inline:{color:'rgb(255, 0, 0)'}}],'color'),{kind:'mixed',value:''});
});

test('batch deduplicates templates into one byte-exact undo operation and rejects stale/ambiguous refs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-multiselect-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'canvas');await fs.cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),dir,{recursive:true});
  const file=path.join(dir,'Profile.dc.html'),original=await fs.readFile(file,'utf8');
  const tx=new EditorTransactions(),events=[];
  const ctx={workspace:root,canvasDir:()=>dir,boardPath:(d,b)=>path.join(d,b),transactions:tx,broadcast:e=>events.push(e),origin:'test'};
  const ids=['heading','subtitle'].map(id=>listElements(original).find(e=>e.attrs.some(a=>a.name==='id'&&a.value===id)));
  const edits=ids.map(e=>({tid:e.tid,style:e.style+'; border-radius: 12px',sourceRef:createSourceRef(original,{canvas:'canvas',board:'Profile.dc.html'},e.tid)}));
  const request={canvas:'canvas',board:'Profile.dc.html',revision:revisionOf(original),edits:[...edits,edits[0]]};
  const out=await handleMultiSelect('/api/edit-batch',request,ctx);
  assert.equal(out.applied,2);assert.equal(out.undoCount,1);assert.equal(events.length,1);
  const after=await fs.readFile(file,'utf8');
  assert.equal((after.match(/border-radius: 12px/g)||[]).length,2);
  assert.ok(after.includes('font-size: 28px'));assert.ok(after.includes('font-size: 16px'));
  await assert.rejects(handleMultiSelect('/api/edit-batch',request,ctx),/修改|版本/);
  assert.equal(await fs.readFile(file,'utf8'),after);
  await tx.undo(dir);assert.equal(await fs.readFile(file,'utf8'),original);
  const bad={...request,edits:[edits[0],{...edits[1],sourceRef:{...edits[1].sourceRef,board:'Wrong.dc.html'}}]};
  await assert.rejects(handleMultiSelect('/api/edit-batch',bad,ctx),/来源/);
  assert.equal(await fs.readFile(file,'utf8'),original);
  await assert.rejects(handleMultiSelect('/api/edit-batch',{...request,edits:[edits[0],{...edits[0],style:'color: red'}]},ctx),/不同样式/);
});
