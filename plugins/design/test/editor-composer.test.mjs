import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function fixture() {
  let receive,clock=0,sequence=0,draft='existing selection',revision=1;
  const replies=[],insertions=[];
  const child={postMessage:(data,origin)=>replies.push({data,origin})};
  const targetWindow={addEventListener:(name,fn)=>{receive=fn;},removeEventListener:(name,fn)=>{if(receive===fn)receive=null;}};
  const frame={current:{contentWindow:child}};
  const sandbox={URL,Date:{now:()=>clock},crypto:{randomUUID:()=>`token-${++sequence}`},window:{__ModuleLoader__:{load(){}}}};
  vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),sandbox);
  const inputActions={captureInsertion:()=>({start:0,end:8,draftRev:revision}),insertText(text,span){if(span.draftRev!==revision)return false;insertions.push({text,span});draft=draft.slice(0,span.start)+text+draft.slice(span.end);revision++;return true;}};
  const dispose=sandbox.setupComposerBridge({frame,sessionId:'session-a',url:'http://127.0.0.1:1234/',channel:'channel-a',inputActions,targetWindow});
  const send=(action,extra={},event={})=>receive?.({source:child,origin:'http://127.0.0.1:1234',data:{type:'dsh-design:composer',sessionId:'session-a',channel:'channel-a',requestId:'request-'+sequence,action,...extra},...event});
  return {send,replies,insertions,dispose,frame,child,get draft(){return draft;},changeDraft(){revision++;},advance(){clock+=31000;}};
}
test('Harness insertion preserves the existing selected draft and never calls submit',()=>{
  const f=fixture();f.send('capture');const token=f.replies.at(-1).data.token;f.send('insert',{token,text:' ANNOTATION '});
  assert.equal(f.draft,'existing ANNOTATION  selection');assert.equal(f.insertions[0].span.start,f.insertions[0].span.end);
  assert.equal(f.replies.at(-1).data.ok,true);assert.equal(f.replies.at(-1).origin,'http://127.0.0.1:1234');
  f.send('insert',{token,text:'duplicate'});assert.equal(f.replies.at(-1).data.ok,false);assert.equal(f.insertions.length,1);
});
test('draft changes, expiry and disposal reject delayed annotation insertion',()=>{
  for(const kind of ['change','expiry','dispose']){const f=fixture();f.send('capture');const token=f.replies.at(-1).data.token;
    if(kind==='change')f.changeDraft();else if(kind==='expiry')f.advance();else f.dispose();
    f.send('insert',{token,text:'late'});assert.equal(f.insertions.length,0);if(kind!=='dispose')assert.equal(f.replies.at(-1).data.ok,false);
  }
});
test('origin, frame source, channel and session are all mandatory',()=>{
  const f=fixture();f.send('capture',{}, {origin:'http://127.0.0.1:9999'});f.send('capture',{}, {source:{}});
  f.send('capture',{channel:'forged'});f.send('capture',{sessionId:'other-session'});assert.equal(f.replies.length,0);
  f.send('capture');const token=f.replies.at(-1).data.token;f.frame.current={contentWindow:{}};f.send('insert',{token,text:'old-frame'});assert.equal(f.insertions.length,0);
});
