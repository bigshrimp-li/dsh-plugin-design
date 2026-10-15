import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkCanvas} from '../dist/check/canvas-check.js';
import {checkDesignSystem,encodeIndexKey,decodeIndexKey} from '../dist/check/system-check.js';
import {checkTokensText} from '../dist/check/tokens-check.js';
import {putBlob,findBlobFile} from '../dist/blobs.js';
import {listElements} from '../dist/editor/source.js';
import {parseMarkup,templateText} from '../dist/design-runtime/markup.js';
import {runtimePath} from '../dist/design-runtime/resource.js';

test('all maintained canvas and design-system examples validate with local rules',async()=>{
 for(const dir of ['test/good','test/editor-fixtures/simple-ui','examples/order-flow','examples/ethiopia-guji','examples/spring-menu']) assert.deepEqual((await checkCanvas(dir)).issues,[],dir);
 for(const dir of ['test/ds-good','examples/ember-ds']) assert.deepEqual((await checkDesignSystem(dir)).issues,[],dir);
});
test('compiler source IDs remain compatible with editing, including raw text and tables',async()=>{
 for(const file of ['test/editor-fixtures/simple-ui/List.dc.html','examples/order-flow/Flavor.dc.html','examples/ethiopia-guji/Main.dc.html']) {
  const source=await fs.readFile(file,'utf8'), parsed=parseMarkup(templateText(source));
  assert.deepEqual(parsed.problems,[]);
  const actual=[]; const walk=ns=>{for(const n of ns){if(n.tid>=0)actual.push({tid:n.tid,tag:n.tag});walk(n.children)}}; walk(parsed.nodes);
  assert.deepEqual(actual,listElements(source).map(({tid,tag})=>({tid,tag})),file);
 }
});
test('token aliases reject cycles and accept shared aliases across themes',()=>{
 const base={color:{themes:[{id:'light',name:'Light'}],tokens:[{name:'a',value:'{b}'},{name:'b',value:{light:'#fff'}}]}};
 assert.deepEqual(checkTokensText(JSON.stringify(base)).problems,[]);
 base.color.tokens[1].value='{a}'; assert.ok(checkTokensText(JSON.stringify(base)).problems.some(p=>p.includes('cyclic')));
 assert.ok(checkTokensText('{"spacing":{"tokens":[{"name":"bad name","value":"1px"}]}}').problems.length);
});
test('asset writes serialize index updates and reject path traversal',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'local-assets-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const assets=await Promise.all(Array.from({length:20},(_,i)=>putBlob(dir,Buffer.from('asset'+i),'image/png')));
 const index=JSON.parse(await fs.readFile(path.join(dir,'index.json'),'utf8'));
 assert.equal(Object.keys(index).length,20);
 for(const a of assets) assert.ok(await findBlobFile(dir,a.id));
 assert.equal(await findBlobFile(dir,'../../etc/passwd'),null);
});
test('non-ASCII design-system keys round trip without prototype keys',()=>{
 for(const name of ['品牌图标.svg','a~b %.png','fonts/regular.woff2']) assert.equal(decodeIndexKey(encodeIndexKey(name)),name);
});
test('bad canvas, unsupported framework imports and symlinks cannot validate as ready',async t=>{
 assert.ok((await checkCanvas('test/bad')).issues.length>=8);
 assert.ok((await checkDesignSystem('test/ds-bad')).issues.length>=3);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'local-validator-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.cp('test/good',dir,{recursive:true});
 const file=path.join(dir,'Main.dc.html'); const source=await fs.readFile(file,'utf8');
 await fs.writeFile(file,source.replace('<x-dc>','<x-dc><x-import name="External"></x-import>'));
 await fs.symlink('/etc/hosts',path.join(dir,'outside.txt'));
 const issues=(await checkCanvas(dir)).issues.map(i=>i.message).join('\n');
 assert.match(issues,/x-import/);assert.match(issues,/Symbolic links/);
});
test('shipping runtime has no legacy bundle or framework',async()=>{
 const code=await fs.readFile(runtimePath(),'utf8');
 assert.match(code,/dsh-dom-1/);
 assert.doesNotMatch(code,/ReactVersion|react\.development|claude|baocut|unpkg|cdnjs|jsdelivr/i);
 assert.ok(Buffer.byteLength(code)<100000);
});
