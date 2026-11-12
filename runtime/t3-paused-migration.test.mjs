import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runT3Ledger,T3NativeLedger} from './t3-native-ledger.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'t3-paused-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const save=(p,v)=>{const path=join(root,p);writeFileSync(path,JSON.stringify(v));return path;};
 const manifest=save('manifest.json',{target_t3_thread_id:'maintenance'});
 const authority_ref=save('authority.json',{content:[{type:'text',text:JSON.stringify({thread:{id:'01a1acc4-a8af-7b72-87a7-30209ea4c70c'},turns:[{items:[{type:'userMessage',id:'human',content:[{type:'text',text:'所有任务暂停; maintenance handles migration'}]}]}]})}]});
 save('t3-workflow.json',{backend:'t3-native',project_id:'project',environment_id:'env',processing:false,roles:{main:'main',maintenance:'maintenance'},migration:{paused:true,manifest,manifest_sha256:createHash('sha256').update(readFileSync(manifest)).digest('hex'),authority_ref,human_message_id:'human',exempt_thread_id:'maintenance'}});
 const evidence_ref=save('native.json',{structuredContent:{thread:{threadId:'idle',projectId:'project',runtimeMode:'full-access',activeRunId:null,runCount:0,itemCount:0,archived:false}}});
 const config_evidence_ref=save('cfg.json',{structuredContent:{threadId:'idle',runtimeMode:'full-access',modelSelection:{model:'gpt-6-astra',options:[{id:'reasoningEffort',value:'xhigh'}]}}});
 const record={source_host:'local',source_thread_id:'old-owner',source_task_id:'T-029',source_title:'Original task',classification:'confirmed_native_unarchived',disposition:'migrated_paused',paused:true,original_model:'gpt-6-astra',original_reasoning_effort:'xhigh',original_state:'complete',historical_hold:{person_review_required:true,expected_head:'original-head'},queued_receipts:[{state:'uncertain',id:'old-receipt'}],destination:{threadId:'idle',projectId:'project',evidence_ref,config_evidence_ref}};
 return {root,save,record,manifest,authority_ref};
}
test('paused import preserves original completion, holds and uncertain receipts without creating native execution',t=>{
 const f=fixture(t);assert.equal(runT3Ledger(f.root,{op:'migration_import',records:[f.record]}).inserted,1);
 assert.equal(runT3Ledger(f.root,{op:'migration_import',records:[f.record]}).reused,1);
 const [r]=runT3Ledger(f.root,{op:'migration_list'});assert.equal(r.original_state,'complete');
 assert.deepEqual(r.historical_hold,f.record.historical_hold);assert.deepEqual(r.queued_receipts,f.record.queued_receipts);
 assert.equal(r.migration_hold.execution_paused,true);assert.equal(r.native_history_imported,false);
 const pending=runT3Ledger(f.root,{op:'pending'});
 assert.deepEqual(pending.tasks,[]);
 assert.deepEqual(pending.migration.counts,{migrated_paused:1});
 assert.equal(pending.migration.resume_authorized,false);
});
test('active owner, model drift, archived source and rewritten actors cannot be imported as paused owners',t=>{
 for(const change of [{classification:'archived'},{original_model:'other'},{original_actor_rewritten:true},{resume_authorized:true}]){
   const f=fixture(t);assert.throws(()=>runT3Ledger(f.root,{op:'migration_import',records:[{...f.record,...change}]}));}
 const f=fixture(t);f.save('native.json',{thread:{threadId:'idle',projectId:'project',runtimeMode:'full-access',activeRunId:'running',runCount:1,itemCount:1}});
 assert.throws(()=>runT3Ledger(f.root,{op:'migration_import',records:[f.record]}),/another owner run/);
});
test('manifest and original Codex user authority are verified without relabeling the relay as human',t=>{
 const f=fixture(t);f.save('authority.json',{thread:{id:'other'},turns:[]});
 assert.throws(()=>runT3Ledger(f.root,{op:'migration_import',records:[f.record]}),/Original complete Codex human/);
 f.save('manifest.json',{target_t3_thread_id:'other'});
 assert.throws(()=>runT3Ledger(f.root,{op:'migration_list'}),/hash changed/);
});
test('global pause blocks admissions and decision execution while preserving existing task states',t=>{
 const f=fixture(t),l=new T3NativeLedger(f.root);t.after(()=>l.close());
 l.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)').run('T3-001','existing','{}',null,'reported_complete',1,0);
 assert.equal(runT3Ledger(f.root,{op:'migration_pause'}).tasks_held,1);
 assert.equal(l.task('T3-001').state,'reported_complete');
 const pending=runT3Ledger(f.root,{op:'pending'});
 assert.equal(pending.migration.task_holds[0].prior_state,'reported_complete');
 assert.equal(pending.migration.task_holds[0].execution_paused,true);
 assert.throws(()=>l.register({}),/Workflow paused/);assert.throws(()=>l.registerReview({}),/Workflow paused/);assert.throws(()=>l.answer({}),/Workflow paused/);
});
test('native human resumption is scoped to imported owners and preserves completion and old holds',t=>{
 const f=fixture(t);runT3Ledger(f.root,{op:'migration_import',records:[f.record]});
 const text='交接后继续任务执行';
 const proof={thread:{threadId:'maintenance',projectId:'project'},items:[{type:'user_message',messageId:'resume',createdBy:'user',creationSource:'server',visibility:'local',textTruncated:false,text}]};
 const evidence_ref=f.save('resume.json',proof),op={op:'migration_resume',target_thread_ids:['idle'],source_message_id:'resume',verbatim_text:text,native_proof:{evidence_ref}};
 assert.equal(runT3Ledger(f.root,op).inserted,1);assert.equal(runT3Ledger(f.root,op).reused,1);
 const [record]=runT3Ledger(f.root,{op:'migration_list'});
 assert.equal(record.resumption.action,'handoff_only_preserve_complete');assert.deepEqual(record.historical_hold,f.record.historical_hold);
 assert.equal(record.migration_hold.execution_paused,true);assert.equal(record.resumption.historical_holds_preserved,true);
 assert.equal(runT3Ledger(f.root,{op:'pending'}).migration.resumed_threads[0].thread_id,'idle');
 assert.throws(()=>runT3Ledger(f.root,{...op,target_thread_ids:['unverified-source']}),/existing migrated owner/);
 proof.items[0].createdBy='agent';f.save('resume.json',proof);assert.throws(()=>runT3Ledger(f.root,op),/Actual complete human/);
});
