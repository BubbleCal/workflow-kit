import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {publishScheduledOccurrence} from './schedule-source.mjs';
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
