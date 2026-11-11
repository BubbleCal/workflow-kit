import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workFixture,DISCOVERY,MAIN} from './test-fixtures/work.mjs';
import {nativeProof} from './test-fixtures/reactive.mjs';

const OWNER='77777777-7777-4777-8777-777777777777';
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
function setup(){
 const f=workFixture(),d=f.c.discovery,root=mkdtempSync(join(tmpdir(),'codex-history-'));
 const save=(name,value)=>{const p=join(root,name+'.json');writeFileSync(p,JSON.stringify(value));return p;};
 d.configure({source_id:'codex',enabled:true,scope:{project_id:'project',host_id:'local'},source_message_id:'human:source',actual_human_verified:true,evidence_ref:'actual-project-scope'});
 const q=d.enqueueDue({enqueue:v=>({queued:true,key:v.key})},'/instance'),b=d.batch(q.batch_id);
 d.begin({batch_id:b.id,generation:b.generation,native_proof:nativeProof({thread:DISCOVERY,message:b.prompt,now:f.now()})});
 const listing={checked_at:new Date(f.now()).toISOString(),job:{req:{tool:'list_threads',arguments:{mode:'history',source:'codex',hostId:'local',archived:false}}},
  readback:envelope({threads:[{id:OWNER,kind:'codex',projectId:'project',hostId:'local',cwd:'/task'}],nextCursor:null})};
 const listingRef=save('listing',listing);
 d.ingest({batch_id:b.id,generation:b.generation,source_id:'codex',page_key:'listing',observations:[],complete:true,evidence_ref:listingRef});
 const parent=d.batch(b.id).pages[0];
 const history=(cursor=null,more=true)=>({source:'codex_app.read_thread',checked_at:new Date(f.now()).toISOString(),
  request:{threadId:OWNER,hostId:'local',cursor},readback:envelope({schemaVersion:1,thread:{id:OWNER,kind:'codex',hostId:'local',cwd:'/task'},
   page:{order:'newest_first',hasMore:more,nextCursor:more?'older-turns':null},turns:[{id:'human-turn',status:'completed',items:[{type:'userMessage',id:'actual-user',content:[{type:'text',text:'Continue the existing task'}]}]}]})});
 const proof=history(),ref=save('history',proof),observation={entity_key:'codex:'+OWNER,item_key:OWNER,version:'human-turn',scope_key:'project',project_id:'project',summary:'Historical source context only',url:'codex://threads/'+OWNER};
 const input={batch_id:b.id,generation:b.generation,source_id:'codex',page_key:'history-1',cursor:null,complete:false,next_cursor:'older-turns',evidence_ref:ref,observations:[observation],followup:{parent_page_key:parent.page_key,thread_id:OWNER,host_id:'local'}};
 return {...f,d,b,root,save,listing,listingRef,history,proof,ref,input,parent,close(){f.c.close();rmSync(root,{recursive:true,force:true});}};
}

test('native chat histories continue separately from an immutable terminal project listing',()=>{
 const f=setup();try{
  assert.equal(f.d.ingest(f.input).recorded,true);assert.equal(f.d.ingest(f.input).recorded,false);
  const finish=()=>f.d.finish({batch_id:f.b.id,generation:f.b.generation,source_results:[{source_id:'codex',complete:true,followups_complete:true}]});
  assert.throws(finish,/supplemental thread cursor/);assert.equal(f.d.sources()[0].last_success_at,null);
  f.d.ingest({...f.input,page_key:'history-2',cursor:'older-turns',complete:true,next_cursor:null,observations:[],evidence_ref:f.save('older',f.history('older-turns',false))});
  assert.equal(f.d.pending({batch_id:f.b.id}).length,1);assert.equal(f.work.list().length,0);
  const row=f.d.pending({batch_id:f.b.id})[0];f.d.classify({observation_id:row.observation_id,disposition:'ignore',reason:'Existing historical context, no new work',evidence_ref:f.ref});
  assert.equal(finish().finished,true);assert.deepEqual(f.d.batch(f.b.id).pages[0],f.parent);assert.equal(f.work.list().length,0);
 }finally{f.close();}
});

test('history streams reject foreign identities, invented human versions and false provider coverage',()=>{
 const changes=[
  f=>f.input.followup.parent_page_key='another-batch',f=>f.input.followup.host_id='remote',f=>f.input.followup.thread_id=MAIN,
  f=>{const x=JSON.parse(f.listing.readback.content[0].text);x.threads[0].projectId='foreign';f.listing.readback=envelope(x);f.save('listing',f.listing);},
  f=>{const x=JSON.parse(f.proof.readback.content[0].text);x.thread.cwd='/other';f.proof.readback=envelope(x);f.save('history',f.proof);},
  f=>{f.proof.source='invented';f.save('history',f.proof);},f=>{f.proof.request.cursor='skipped';f.save('history',f.proof);},
  f=>f.input.observations[0].version='not-an-actual-turn',f=>f.input.observations[0].item_key=MAIN,
  f=>{const x=JSON.parse(f.proof.readback.content[0].text);x.turns[0].items=[{type:'agentMessage',text:'Continue'}];f.proof.readback=envelope(x);f.save('history',f.proof);},
  f=>{const x=JSON.parse(f.proof.readback.content[0].text);x.turns[0].items[0].content[0].text='[workflow-event:runtime:task:wake:1]';f.proof.readback=envelope(x);f.save('history',f.proof);},
  f=>{f.input.complete=true;f.input.next_cursor=null;}
 ];
 for(const change of changes){const f=setup();try{change(f);assert.throws(()=>f.d.ingest(f.input));assert.equal(f.d.batch(f.b.id).pages.length,1);assert.equal(f.d.pending({batch_id:f.b.id}).length,0);assert.equal(f.d.sources()[0].last_success_at,null);}finally{f.close();}}
});

test('history continuation retains exact cursors and detects changed original listing evidence',()=>{
 const f=setup();try{
  f.d.ingest(f.input);
  assert.throws(()=>f.d.ingest({...f.input,page_key:'skipped',cursor:null}),/cursor/);
  f.listing.checked_at=new Date(f.now()-1).toISOString();f.save('listing',f.listing);
  assert.throws(()=>f.d.ingest({...f.input,page_key:'older',cursor:'older-turns',complete:true,next_cursor:null,observations:[],evidence_ref:f.save('older',f.history('older-turns',false))}),/listing/);
  assert.equal(f.d.batch(f.b.id).pages.length,2);assert.deepEqual(f.d.batch(f.b.id).pages[0],f.parent);
 }finally{f.close();}
});

test('an actual human message appended inside a machine-started turn retains its own source version',()=>{
 const f=setup();try{
  const raw=JSON.parse(f.proof.readback.content[0].text);
  raw.turns[0].items.unshift({type:'userMessage',id:'machine-delivery',content:[{type:'text',text:'[workflow-event:runtime:owner:wake:1]'}]});
  f.proof.readback=envelope(raw);f.save('history',f.proof);f.input.observations[0].version='actual-user';
  assert.equal(f.d.ingest(f.input).recorded,true);
  assert.throws(()=>f.d.ingest({...f.input,page_key:'machine',observations:[{...f.input.observations[0],version:'machine-delivery'}]}),/human/);
  assert.equal(f.d.pending({batch_id:f.b.id}).length,1);
 }finally{f.close();}
});
