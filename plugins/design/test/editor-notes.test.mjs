import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cp,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {planCanvasIndex,validateCanvasAnnotations,validateGuide} from '../dist/editor/canvas-index.js';
import {handleNotes} from '../dist/editor/notes-routes.js';
import {EditorTransactions,revisionOf} from '../dist/editor/transactions.js';
import {guideGeometry} from '../src/editor/assets/notes.js';
const fixture=JSON.parse(await readFile(new URL('./editor-fixtures/simple-ui/canvas.json',import.meta.url),'utf8'));
function index(){const value=structuredClone(fixture);value.pages=[{id:'one',name:'One'},{id:'two',name:'Two'}];value.boards['Profile.dc.html'].page='one';value.boards['Layout.dc.html'].page='one';value.boards['List.dc.html'].page='two';value.boards['Profile.dc.html'].x=-300;value.boards['Profile.dc.html'].y=-400;value.custom={retained:true};value.notes={drawing:{kind:'rect',x:10,y:10,text:'user shape',custom:{keep:true}}};return value;}
const request=extra=>({board:'Profile.dc.html',...extra});

test('note edit preserves opaque drawings and unknown fields; titles use page groups and avoid overlap',()=>{
 const before=index();const drawing=structuredClone(before.notes.drawing);
 let next=planCanvasIndex(before,request({action:'add-note',id:'todo',note:{x:-10,y:-20,text:'{{ literal }}',w:240,fill:'orange',custom:7,page:'one'}}));
 next=planCanvasIndex(next,request({action:'update-note',id:'todo',patch:{x:-50,text:'updated'}}));
 assert.equal(next.notes.todo.custom,7);assert.deepEqual(next.notes.drawing,drawing);assert.deepEqual(next.custom,{retained:true});assert.equal(before.notes.todo,undefined);
 next=planCanvasIndex(next,request({action:'add-note',id:'heading',note:{kind:'title1',text:'Group',x:0,y:0,page:'one'}}));
 assert.equal(next.notes.heading.x,-300);assert.ok(next.notes.heading.y<=-623);assert.ok(next.notes.heading.maxW>1000);
 const second=planCanvasIndex(next,request({action:'add-note',id:'heading2',note:{kind:'title1',text:'Another',x:0,y:0,page:'one'}}));
 assert.ok(second.notes.heading2.y<next.notes.heading.y-90);
 assert.throws(()=>planCanvasIndex(next,request({action:'add-note',id:'single',note:{kind:'title1',text:'Single',x:0,y:0,maxW:100,page:'two'}})),/至少两块/);
 for(const action of ['update-note','delete-note'])assert.throws(()=>planCanvasIndex(next,request({action,id:'drawing',patch:{text:'bad'}})),/用户绘制/);
});

test('annotation field and count limits reject unsafe rendering inputs',()=>{
 for(const patch of [{w:0},{x:Infinity},{size:'0px'},{maxH:-1},{color:'url(bad)'},{fill:'black'},{bold:'yes'},{page:'missing'}]){
  const value=index();value.notes.note={x:0,y:0,text:'note',w:240,...patch};assert.throws(()=>validateCanvasAnnotations(value));
 }
 for(const guide of [{kind:'grid',size:0},{kind:'rows',count:0},{kind:'rows',count:Infinity},{kind:'columns',gutter:-1},{kind:'columns',margin:99999},{kind:'rows',align:'side'},{kind:'grid',color:'url(x)'},{kind:'grid',color:'rgb(1)'},{kind:'grid',hidden:'true'}])assert.throws(()=>validateGuide(guide,{w:520,h:560}));
 const six=index();six.boards['Profile.dc.html'].guides=Array.from({length:6},()=>({kind:'grid',size:8}));validateCanvasAnnotations(six);six.boards['Profile.dc.html'].guides.push({kind:'rows'});assert.throws(()=>validateCanvasAnnotations(six),/6/);
 const full=index();full.notes=Object.fromEntries(Array.from({length:201},(_,i)=>['n'+i,{x:0,y:0,text:'n',w:100}]));assert.throws(()=>validateCanvasAnnotations(full),/200/);
});

test('guide layout implements auto/default rows, fixed alignment, hidden state and grid',()=>{
 const b={w:520,h:560};
 const rows=guideGeometry({kind:'rows'},b);assert.equal(rows.height,560);assert.match(rows.backgroundImage,/8px/);
 const centered=guideGeometry({kind:'columns',count:2,size:80,gutter:20,margin:10,align:'center',offset:5},b);assert.equal(centered.left,175);assert.equal(centered.width,180);
 const end=guideGeometry({kind:'columns',count:2,size:80,gutter:20,margin:10,align:'end',offset:5},b);assert.equal(end.left,325);
 assert.equal(guideGeometry({kind:'grid',hidden:true},b),null);assert.equal(guideGeometry({kind:'grid',size:12},b).backgroundSize,'12px 12px');
});

test('index route saves one operation each and restores original bytes across note and guide changes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-notes-'));t.after(()=>rm(root,{recursive:true,force:true}));await cp(new URL('./editor-fixtures/simple-ui/',import.meta.url),root,{recursive:true});
 const file=path.join(root,'canvas.json');await writeFile(file,JSON.stringify(index(),null,3)+'\n');const original=await readFile(file);
 const transactions=new EditorTransactions(),events=[];
 const ctx={workspace:root,canvasDir:()=>root,boardPath:(dir,name)=>path.join(dir,name),transactions,broadcast:e=>events.push(e),origin:'test'};
 let revision=revisionOf(original);
 async function edit(data){const out=await handleNotes('/api/canvas-index',{canvas:'.',board:'Profile.dc.html',revision,...data},ctx);revision=out.indexRevision;return out;}
 const made=await edit({action:'add-note',id:'note',note:{x:-100,y:50,text:'{{ literal }}',w:240,fill:'orange'}});assert.equal(made.index.notes.note.text,'{{ literal }}');assert.equal(made.history.undoCount,1);
 await edit({action:'update-note',id:'note',patch:{x:100,y:-500,w:300,maxH:420}});
 await edit({action:'update-note',id:'note',patch:{text:'changed',size:'24px',italic:true}});
 const noOp=await edit({action:'update-note',id:'note',patch:{text:'changed'}});assert.equal(noOp.changed,false);assert.equal(noOp.history.undoCount,3);
 await edit({action:'set-guides',guides:[{kind:'columns',count:4,margin:20,gutter:10,color:'#ff00001a'}]});
 await edit({action:'delete-note',id:'note'});
 for(let i=0;i<5;i++)await transactions.undo(root);
 assert.deepEqual(await readFile(file),original);assert.equal(events.length,5);
 await assert.rejects(handleNotes('/api/canvas-index',{canvas:'.',board:'Profile.dc.html',revision:'stale',action:'delete-note',id:'drawing'},ctx),{status:409});
});
