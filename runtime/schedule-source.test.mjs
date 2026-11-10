import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {publishScheduledOccurrence,recoverScheduledOccurrence} from './schedule-source.mjs';
import {fixture,contract,nativeProof,OWNER,NOW} from './test-fixtures/reactive.mjs';

test('schedule registration does not run early and one occurrence never replays the work',()=>{
  const root=mkdtempSync(join(tmpdir(),'schedule-source-')),f=fixture();try{
    const c={...contract(),trigger_only:true,schedule_sources:['daily-brief']};
    f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:c,source_message_id:'human',actual_human_verified:true});
    f.event('adopt',c,{type:'task_adopted'});f.activate();
    assert.equal(f.s.task('T-1').wake_at,null);assert.equal(f.s.reserveQueuedWake('T-1').reserved,false);
    f.event('old-recovery',{previous_driver:'scheduled'},{type:'recovery'});assert.equal(f.s.task('T-1').wake_at,null);
    const prompt='Prepare the original private daily brief, with no external delivery.',file=join(root,'original.txt');writeFileSync(file,prompt);
    const producer='44444444-4444-4444-8444-444444444444';
    const source={id:'daily-brief',enabled:true,task_id:'T-1',owner_thread_id:OWNER,source_thread_id:producer,original_source_thread_id:OWNER,timezone:'Asia/Shanghai',original_prompt_file:file,original_prompt_sha256:createHash('sha256').update(prompt).digest('hex'),authorization_ref:'human:original-schedule'};
    writeFileSync(join(root,'runtime-schedules.json'),JSON.stringify({sources:[source]}));
    const input={schedule_id:source.id,native_proof:nativeProof({thread:producer,message:'<current_time_iso>2026-11-03T15:45:00Z</current_time_iso>\n[workflow-schedule-source:daily-brief]'})};
    assert.equal(publishScheduledOccurrence(root,f.s,input,NOW).published,true);
    assert.equal(publishScheduledOccurrence(root,f.s,input,NOW).duplicate,true);
    assert.equal(f.s.checkpoint('T-1').events.filter(e=>e.type==='schedule_due').length,1);
    assert.equal(f.s.checkpoint('T-1').facts.find(x=>x.subject==='schedule:daily-brief').data.occurrence_date,'2026-11-03');
    assert.equal(f.s.task('T-1').owner_id,OWNER);
    const w=f.begin();f.decide({wake_id:w.id,disposition:'cycle_complete',plan:undefined,acceptance:c.requirements.map(r=>({requirement_id:r.id,passed:true,evidence_ref:'actual-brief'}))});
    assert.equal(f.s.finish({task_id:'T-1',wake_id:w.id,turn_id:'native-turn',evidence_ref:'brief'}).task_complete,false);
    assert.equal(f.s.task('T-1').status,'waiting');assert.equal(f.s.task('T-1').wake_at,null);
    input.native_proof.readback.thread.id='another-owner';assert.throws(()=>publishScheduledOccurrence(root,f.s,input,NOW),/native schedule producer/);
  }finally{f.c.close();rmSync(root,{recursive:true,force:true});}
});


test('a proven failed schedule occurrence replays its immutable capture once after binding repair, with original time and owner',()=>{
 const root=mkdtempSync(join(tmpdir(),'schedule-repair-')),f=fixture();try{
  f.s.amend({task_id:'T-1',expected_contract_rev:1,contract:{...contract(),trigger_only:true,schedule_sources:['daily']},source_message_id:'human:original',actual_human_verified:true});f.activate();
  const file=join(root,'original.txt'),text='Original read-only scheduled scope';writeFileSync(file,text);const hash=createHash('sha256').update(text).digest('hex'),producer='44444444-4444-4444-8444-444444444444';
  const source={id:'daily',enabled:true,task_id:'T-1',owner_thread_id:OWNER,source_thread_id:producer,timezone:'Asia/Shanghai',original_prompt_file:file,original_prompt_sha256:hash,authorization_ref:'actual-source'};writeFileSync(join(root,'runtime-schedules.json'),JSON.stringify({sources:[source]}));
  const original={op:'schedule_event',schedule_id:'daily',native_proof:nativeProof({thread:producer,message:'[workflow-schedule-source:daily]',now:NOW})};writeFileSync(join(root,'request.json'),JSON.stringify(original));writeFileSync(join(root,'failure.json'),JSON.stringify({exit_code:1,stdout:JSON.stringify({error:'Original schedule scope changed; reconcile its binding'})}));
  f.advance(3600000);const human=nativeProof({thread:'human-thread',message:'Repair the existing schedule and its missed occurrence',turn:'human-turn',now:f.now()});human.readback.turns[0].items[0].id='actual-human-repair';
  const input={schedule_id:'daily',actual_human_verified:true,source_message_id:'actual-human-repair',source_thread_id:'human-thread',source_turn_id:'human-turn',verbatim_text:'Repair the existing schedule and its missed occurrence',human_authorization:human,evidence_ref:'actual-repair-authority',original_request_file:join(root,'request.json'),original_failure_file:join(root,'failure.json'),expected_prompt_sha256:hash};
  assert.throws(()=>publishScheduledOccurrence(root,f.s,original,f.now()),/Fresh/);assert.throws(()=>recoverScheduledOccurrence(root,f.s,{...input,expected_prompt_sha256:'wrong'},f.now()),/scope changed/);
  const result=recoverScheduledOccurrence(root,f.s,input,f.now());assert(result.published);assert(result.original_native_capture_preserved);assert(recoverScheduledOccurrence(root,f.s,input,f.now()).duplicate);
  const event=f.s.checkpoint('T-1').events.find(e=>e.type==='schedule_due');assert.equal(event.source_at,NOW);assert.equal(f.s.task('T-1').owner_id,OWNER);assert.equal(f.c.db.prepare("SELECT COUNT(*) n FROM rt_events WHERE type='schedule_due'").get().n,1);
 }finally{f.c.close();rmSync(root,{recursive:true,force:true});}
});
