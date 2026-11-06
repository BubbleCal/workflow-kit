import {nativeReadback} from './native-queue.mjs';
import {assessDifficulty} from './model-selection.mjs';

const parse=value=>value?JSON.parse(value):null;
const text=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new Error(`${name} is required`);};
const refs=value=>Array.isArray(value)&&value.length&&value.every(v=>typeof v==='string'&&v.trim());

// Results are provenance, not parent goals: independent improvements never reopen
// a completed assessment or inherit permission for deployment or external writes.
export class ResultFollowthrough {
  constructor(work){
    this.work=work;this.db=work.db;this.now=work.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_result_reviews (
      review_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,owner_id TEXT NOT NULL,turn_id TEXT,
      evidence_ref TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_result_followups (
      followup_key TEXT PRIMARY KEY,origin_task_id TEXT NOT NULL,report_key TEXT NOT NULL,
      canonical_key TEXT NOT NULL,data TEXT NOT NULL,task_id TEXT,state TEXT NOT NULL,
      reason TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  }
  policy(){return parse(this.db.prepare("SELECT data FROM work_rules WHERE key='accept_result_followups'").get()?.data);}
  reviewInside(taskId,{key,turn_id,evidence_ref,force=false}){
    if(!this.policy()?.enabled)return {queued:false};
    const task=this.work.get(taskId);
    if(!task?.owner_thread_id||task.state!=='accepted'||task.data.meeting_preparation||task.data.meeting_service)return {queued:false};
    if(!force&&this.db.prepare('SELECT 1 FROM work_reports WHERE task_id=? AND json_extract(data,\'$.wake_id\')=?').get(taskId,key))return {queued:false,reason:'result_already_reported'};
    const review_key=`result-review:${taskId}:${key}`;
    this.db.prepare("INSERT OR IGNORE INTO work_result_reviews VALUES (?,?,?,?,?,'pending',?)")
      .run(review_key,taskId,task.owner_thread_id,turn_id??null,evidence_ref,this.now());
    return {queued:true,review_key};
  }
  queueReview({task_id,source_message_id,actual_human_verified,evidence_ref}){
    if(actual_human_verified!==true||!this.policy()?.enabled)throw new Error('Explicit authorized named-result catchup required');
    text(source_message_id,'actual catchup request');text(evidence_ref,'result evidence');
    const task=this.work.get(task_id),execution=this.work.execution(task_id);
    if(!task||execution?.status!=='complete')throw new Error('Named catchup needs an actually completed task');
    return this.work.atomic(()=>this.reviewInside(task_id,{key:`catchup:${source_message_id}`,evidence_ref}));
  }
  verifyReview(input,task){
    const review=this.db.prepare('SELECT * FROM work_result_reviews WHERE review_key=? AND task_id=?').get(input.review_key??'',task.id);
    const proof=input.native_proof,read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at);
    const turn=review?.turn_id?read?.turns?.find(t=>t.id===review.turn_id):read?.turns?.[0];
    if(!review||proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>this.now()+5000||this.now()-at>60000||
      read?.thread?.id!==task.owner_thread_id||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==task.data.workspace||
      !turn?.id||!['completed','failed','interrupted'].includes(turn.status)||!proof.evidence_ref)
      throw new Error('Fresh original-owner terminal result proof and an exact pending review are required');
    return review;
  }
  recordInside(parent,reportKey,followups){
    if(!Array.isArray(followups))throw new Error('Structured followups must be an array');
    const rule=this.policy(),results=[];
    for(const f of followups){
      for(const k of ['canonical_key','problem','evidence_limits','expected_benefit','reason'])text(f[k],`followup ${k}`);
      if(!refs(f.evidence_refs)||!['implement','existing','decision','blocked','no_action'].includes(f.disposition))throw new Error('Followup needs evidence and an explicit disposition');
      if(['implement','existing'].includes(f.disposition)&&(!Array.isArray(f.actions)||!f.actions.length||f.actions.some(a=>!['implementation','testing','benchmark'].includes(a))))throw new Error('Followup implementation authority covers only implementation, testing and benchmarks');
      if(f.existing_work_evidence_ref&&(f.disposition!=='existing'||!f.evidence_refs.includes(f.existing_work_evidence_ref)||!f.existing_task_id))throw new Error('Already assigned followup needs its exact existing task and scope evidence');
      const key=`${reportKey}:${f.canonical_key}`,encoded=JSON.stringify(f),prior=this.db.prepare('SELECT * FROM work_result_followups WHERE followup_key=?').get(key);
      if(prior){if(prior.data!==encoded)throw new Error('Immutable followup changed');results.push(prior);continue;}
      let task=f.existing_task_id?this.work.get(f.existing_task_id):this.work.get(f.canonical_key),state=f.disposition,reason=f.reason;
      if(f.existing_task_id&&(!task||task.canonical_key!==f.canonical_key))throw new Error('Existing followup must match its canonical task identity');
      const parentContract=parse(this.db.prepare('SELECT contract FROM rt_tasks WHERE task_id=?').get(parent.id)?.contract);
      const constraints=[...(parent.data.constraints??[]),...(parentContract?.constraints??[])].join('\n');
      const held=parent.state!=='accepted'||this.work.execution(parent.id)?.mode==='paused'||parentContract?.execution_hold||parent.data.implementation_hold===true||
        parent.data.exploration?.allow_product_changes===false||/assessment.only|review.only|implementation hold|do not implement|no product (?:code )?changes|不得实现|禁止实现/i.test(constraints);
      if(['implement','existing'].includes(f.disposition)){
        if(!rule?.enabled||!rule.allowed_kinds.includes('work')){state='blocked';reason='No standing result implementation authorization';}
        else if(held){state='blocked';reason='Original assessment-only or implementation hold is preserved';}
        else if(f.requires_additional_authority===true){state='decision';reason='A material choice or expanded goal needs Yang';}
        else if(task?.state==='completed'||task&&this.work.execution(task.id)?.status==='complete'){state='complete';reason='Existing canonical task already completed';}
        else if(task&&['dismissed','superseded'].includes(task.state)||task&&this.work.execution(task.id)?.mode==='paused'){
          state='blocked';reason='Existing task is completed, dismissed, superseded or explicitly paused';
        }else{
          if(!task){
            const t=f.task;
            if(!t||!Array.isArray(t.requirements)||!t.requirements.length||!t.workspace||t.parent_id||t.schedule_sources||t.trigger_only)
              throw new Error('Independent followup needs a concrete workspace and acceptance, without a parent or new schedule');
            const difficulty=assessDifficulty(t.difficulty_assessment),repos=difficulty.target_repositories??[];
            if(!repos.length||repos.some(repo=>!this.work.config.scope?.repositories?.includes(repo)))throw new Error('Followup target repository is outside authorized project scope');
            task=this.work.createInside({title:t.title,objective:t.objective,workspace:t.workspace,requirements:t.requirements,depends_on:t.depends_on,
              kind:'work',canonical_key:f.canonical_key,state:'candidate',constraints:[...(t.constraints??[]),
              'Bounded implementation and testing only; no new production deployment, release, external messaging, or changes to another owner\'s PR. Preserve existing owner-delivery gates.'],source:{kind:'task_result',key,origin_task_id:parent.id,evidence_refs:f.evidence_refs}}).task;
            const data={...task.data,difficulty_assessment:difficulty,result_origin:{task_id:parent.id,report_key:reportKey,followup_key:key}};
            this.db.prepare('UPDATE work_items SET data=? WHERE id=?').run(JSON.stringify(data),task.id);
          }
          if(task.state!=='accepted'){
            if(!['candidate','draft'].includes(task.state))throw new Error('Followup task is unavailable for admission');
            if(task.kind!=='work'||!task.data.requirements?.length||!task.data.workspace)throw new Error('Existing candidate needs concrete work scope and acceptance before admission');
            this.db.prepare("UPDATE work_items SET state='accepted',authorization=?,revision=revision+1,updated_at=? WHERE id=?")
              .run(JSON.stringify({kind:'standing_policy',policy:'accept_result_followups',source_message_id:rule.source_message_id,evidence_ref:rule.evidence_ref,actual_human_verified:true}),this.now(),task.id);
            this.db.prepare("UPDATE work_notices SET state='superseded' WHERE task_id=? AND state='pending'").run(task.id);
          }
          state=task.owner_thread_id?'existing_owner':'needs_owner';
        }
      }
      this.db.prepare('INSERT INTO work_result_followups VALUES (?,?,?,?,?,?,?,?,?)')
        .run(key,parent.id,reportKey,f.canonical_key,encoded,task?.id??null,state,reason,this.now());
      if(state==='decision')this.db.prepare("INSERT OR IGNORE INTO work_notices VALUES (?,?,?,'pending')").run(`result-decision:${key}`,parent.id,
        JSON.stringify({task_id:parent.id,result_followup_decision:true,text:`${parent.id} · 结果后续待决：${f.problem}\n${reason}\n证据：${f.evidence_refs.join(', ')}`}));
      results.push(this.db.prepare('SELECT * FROM work_result_followups WHERE followup_key=?').get(key));
    }
    return results;
  }
  status(){
    return this.db.prepare('SELECT * FROM work_result_followups ORDER BY updated_at,followup_key').all().map(row=>{
      const task=row.task_id&&this.work.get(row.task_id),execution=task&&this.work.execution(task.id);
      const data=parse(row.data),eventId=`result-followup:${row.followup_key}`;
      const started=task?.owner_thread_id&&this.db.prepare(`SELECT w.id,w.turn_id FROM rt_wakes w WHERE w.owner_id=? AND w.started_at IS NOT NULL AND w.turn_id IS NOT NULL
        AND w.id IN (SELECT wake_id FROM rt_wake_members WHERE task_id=?) AND (? OR EXISTS (SELECT 1 FROM json_each(w.event_ids) WHERE value=?)
        OR EXISTS (SELECT 1 FROM rt_events e JOIN rt_decisions d ON d.id=e.decision_id WHERE e.event_id=? AND e.disposition='handled'
          AND d.created_at>=w.started_at AND (w.completed_at IS NULL OR d.created_at<=w.completed_at))) ORDER BY w.started_at DESC LIMIT 1`)
        .get(task.owner_thread_id,task.id,data.existing_work_evidence_ref||task.data.result_origin?.followup_key===row.followup_key?1:0,eventId,eventId);
      return {...row,data,owner_thread_id:task?.owner_thread_id??null,execution:execution??null,
        execution_started:!!started,actual_wake_id:started?.id??null,actual_turn_id:started?.turn_id??null};
    });
  }
  pending(){
    if(!this.policy()?.enabled)return {reviews:[],owners:[]};
    return {reviews:this.db.prepare("SELECT * FROM work_result_reviews WHERE state='pending' ORDER BY created_at").all(),
      owners:this.status().filter(r=>['needs_owner','owner_requested','owner_bound','queued','routed','waiting_dependency','creation_failed','creation_uncertain'].includes(r.state)&&!r.execution_started)};
  }
  advance(reactive,{queue_compatibility_verified=false}={}){
    const rule=this.policy();if(!rule?.enabled)return [];
    const changes=[];
    for(const row of this.status()){
      if(!row.task_id||['blocked','decision','no_action','complete'].includes(row.state))continue;
      const task=this.work.get(row.task_id),execution=reactive.task(task.id);
      let state=row.state,reason=row.reason;
      if(execution?.mode==='paused'){state='blocked';reason='Preserve the existing task pause';}
      else if(row.execution_started){state=execution?.status==='complete'?'complete':'started';}
      else if(execution&&!row.data.existing_work_evidence_ref&&task.data.result_origin?.followup_key!==row.followup_key){
        if(execution.status!=='complete')this.route(reactive,row,task);
        state=execution.status==='complete'?'complete':'routed';
      }else if(!task.owner_thread_id){
        const request=this.work.requestOwner({task_id:task.id,source_message_id:rule.source_message_id,verbatim_text:rule.verbatim_text,actual_human_verified:true,explicit_new_thread_request_verified:true});
        const action=this.db.prepare('SELECT state FROM actions WHERE action_key=?').get(request.action_key);
        state=['uncertain','claimed'].includes(action?.state)?'creation_uncertain':action?.state==='failed'?'creation_failed':'owner_requested';
        reason=state.startsWith('creation_')?'Reconcile the exact creation action; never create a replacement task or blindly retry':row.reason;
      }else if(!execution&&queue_compatibility_verified){
        const blockers=this.work.blockers(task.id);
        if(blockers.length){state='waiting_dependency';reason=blockers.join(', ');}
        else{
          this.work.start(reactive,{task_id:task.id,queue_compatibility_verified:true});state='queued';
          if(task.data.result_origin?.followup_key!==row.followup_key&&!row.data.existing_work_evidence_ref){
            this.route(reactive,row,task);state='routed';
          }
        }
      }else if(execution&&row.state!=='routed'){state='queued';}
      if(state!==row.state||reason!==row.reason)this.db.prepare('UPDATE work_result_followups SET state=?,reason=?,updated_at=? WHERE followup_key=?').run(state,reason,this.now(),row.followup_key);
      changes.push({followup_key:row.followup_key,task_id:task.id,state,execution_started:row.execution_started});
    }
    return changes;
  }
  route(reactive,row,task){
    const event_id=`result-followup:${row.followup_key}`;
    if(this.db.prepare('SELECT 1 FROM rt_events WHERE event_id=?').get(event_id))return;
    reactive.ingest({task_id:task.id,event_id,source:'task_result',subject:`result:${row.origin_task_id}`,type:'result_followup',
      observed_at:this.db.prepare('SELECT created_at FROM work_reports WHERE report_key=?').get(row.report_key).created_at,
      payload:{followup:row.data,origin_task_id:row.origin_task_id},evidence_ref:row.report_key,debounce_ms:0});
  }
}
