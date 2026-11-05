import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolRunner} from '../src/host/tool-runner.js';
const make=(program,handler=()=>({kind:'saved',data:{itemId:'actual'},operationId:'committed'}))=>{
  const calls=[];const bundle={id:'v2',types:[{id:'note',version:1,fields:[]}],tools:[{id:'notes',description:'Record notes',commands:{run:{program}}}]};
  const runner=createToolRunner({domain:{async execute(...args){calls.push(args);return handler(...args);}},getBundle:async()=>bundle});
  return {calls,run:(requestId='request',binding={})=>runner.run({toolId:'notes',command:'run',input:{title:'Synthetic'},requestId},{objectiveId:'O_test',...binding})};
};
test('invalid write identities, stale versions and trial side effects never become read success',async()=>{
  const write=make([{op:'save',typeId:'note',input:{title:{ref:'input.title'}}}]);
  assert.equal((await write.run(null)).kind,'failed');assert.equal(write.calls.length,0);
  assert.equal((await write.run('request',{bundleId:'v1'})).kind,'conflict');assert.equal(write.calls.length,0);
  const action=make([{op:'action',input:{itemId:'actual'}}]);
  assert.equal((await action.run('trial',{executionScope:'trial'})).error.code,'TRIAL_WRITE_FORBIDDEN');assert.equal(action.calls.length,0);
});
test('pending branch halts the program and output projection preserves the committed identity',async()=>{
  const pending=make([{op:'if',test:'present',value:{ref:'input.title'},then:[{op:'save',typeId:'note',input:{}}]},{op:'output',value:{itemId:'invented'}}],()=>({kind:'pending',data:{materialId:'actual-material'}}));
  assert.equal((await pending.run()).data.materialId,'actual-material');assert.equal(pending.calls.length,1);
  const projection=make([{op:'save',typeId:'note',input:{}},{op:'output',value:{itemId:'invented'}}]);
  const receipt=await projection.run();assert.equal(receipt.data.itemId,'actual');assert.equal(receipt.operationId,'committed');assert.equal(receipt.data.projection.itemId,'invented');
});
test('program budgets and action grants are enforced before business submission',async()=>{
  const multiple=make([{op:'save',typeId:'note',input:{}},{op:'save',typeId:'note',input:{}}]);
  assert.equal((await multiple.run()).kind,'failed');assert.equal(multiple.calls.length,0);
  const readonly=make([{op:'save',typeId:'note',input:{}}]);assert.equal((await readonly.run('read-only',{allowedActions:['read','suggest']})).kind,'failed');assert.equal(readonly.calls.length,0);
});

test('record forms map typed fields to declared flat CLI inputs and leave missing business fields to domain pending',async()=>{
  const calls=[];
  const bundle={id:'v',types:[{id:'material',version:1,fields:[{id:'url',kind:'text',required:true}]}],tools:[{id:'materials',description:'Material records',commands:{save:{input:{type:'object',properties:{url:{type:'string'}},required:['url']},program:[{op:'save',typeId:'material',input:{title:{ref:'input.title'},fields:{url:{ref:'input.url'}}}}]}}}]};
  const runner=createToolRunner({domain:{async execute(command,input){calls.push(input);return input.fields.url?{kind:'saved',data:{itemId:'material'}}:{kind:'pending',data:{materialId:'pending',missing:['url']}};}},getBundle:async()=>bundle});
  assert.equal((await runner.run({toolId:'materials',command:'save',input:{title:'Form input',fields:{url:'https://example.com/test'}},requestId:'form'},{})).kind,'saved');
  assert.equal(calls[0].fields.url,'https://example.com/test');
  assert.equal((await runner.run({toolId:'materials',command:'save',input:{title:'Missing URL',fields:{}},requestId:'pending'},{})).kind,'pending');
  assert.equal(calls.length,2);
  const conflict=await runner.run({toolId:'materials',command:'save',input:{url:'different',fields:{url:'https://example.com/test'}},requestId:'conflict'},{});
  assert.equal(conflict.kind,'failed');assert.equal(calls.length,2);
});
