import {randomUUID} from 'node:crypto';
import {nativeReadback} from './native-queue.mjs';
import {readReviewIntake,reviewKey} from './review-intake.mjs';

const json=JSON.stringify;
const fresh=(value,now)=>Number.isFinite(Date.parse(value))&&Date.parse(value)<=now+5000&&now-Date.parse(value)<=300000;

export class ReviewClosure {
  constructor(control,policy=readReviewIntake(control.work.config.instance_root)) {this.c=control;this.policy=policy;}
  identity(id) {
    const w=this.c.work.get(id),t=this.c.reactive.task(id);
    if(!w||!t||w.data.source?.review_only!==true||w.kind==='project'||t.contract.schedule_sources?.length||t.contract.service_lane)return null;
    const prs=w.data.pull_requests;
    if(prs?.length!==1)return null;
    const pr=prs[0],url=`https://github.com/${pr.repository}/pull/${pr.pr_number}`;
    if(w.canonical_key!==reviewKey(url))return null;
    return {w,t,url};
  }
  targets() {
    return this.c.reactive.tasks().map(t=>this.identity(t.task_id)).filter(Boolean).filter(({w,t})=>
      !this.c.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND kind='archive' AND state='sent'").get(t.task_id)&&
      (!t.contract.retired||w.data.review_closure)).map(({w,t,url})=>({task_id:t.task_id,owner_thread_id:t.owner_id,pr_url:url,
        review_status:t.status,terminal_pr:w.data.review_closure?.pr??null}));
  }
  complete(input) {return this.c.atomic(()=>{
    const rule=this.policy?.terminal_pr_completion;
    if(rule?.enabled!==true||!rule.source_message_id||!rule.evidence_ref)throw new Error('Explicit terminal-review completion policy is required');
    const x=this.identity(input.task_id);if(!x)throw new Error('Only an exact single-PR review task can complete this way');
    const {w,t,url}=x,actor=input.executor_thread_id;
    if(![this.c.work.config.threads?.main,this.policy.owner_thread_id,t.owner_id].filter(Boolean).includes(actor))throw new Error('Only main, Review Queue or the original reviewer may close review scope');
    const p=input.pr;
    if(p?.url!==url||!fresh(p.checked_at,this.c.now())||!p.evidence_ref||!['merged','closed'].includes(p.state)||
      !/^[a-f0-9]{40}$/.test(p.head_sha??'')||!Number.isFinite(Date.parse(p.closed_at)))throw new Error('Fresh exact terminal PR evidence is required');
    if(p.state==='merged'&&(!/^[a-f0-9]{40}$/.test(p.merge_sha??'')||!Number.isFinite(Date.parse(p.merged_at))))throw new Error('Merged PR needs its actual merge SHA and time');
    const proof=input.native_proof,read=proof&&nativeReadback(proof.readback),turn=read?.turns?.[0];
    if(proof?.source!=='codex_app.read_thread'||!fresh(proof.checked_at,this.c.now())||!proof.evidence_ref||
      read?.thread?.id!==t.owner_id||!['idle','notLoaded'].includes(read.thread.status?.type)||read.thread.status?.activeFlags?.length||
      !['completed','interrupted','failed'].includes(turn?.status))throw new Error('Fresh quiescent original owner proof is required');
    if(turn.status!=='completed'&&(input.interruption_reconciled!==true||!input.interruption_evidence_ref))throw new Error('Preserve and reconcile interrupted work before closure');
    if(input.underlying_job_running!==false||input.pending_delivery!==false||input.pending_cleanup!==false||input.queued_input!==false||
      input.resources_preserved!==true||!input.evidence_ref)throw new Error('Preserved artifacts and no live job, input or outstanding delivery/cleanup are required');
    if(this.c.reactive.openWake(t.task_id)||this.c.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('prepared','claimed','uncertain')").get(t.task_id))throw new Error('Reconcile pending wake or action before completion');
    if(w.data.review_closure)return {completed:true,replayed:true,task_id:t.task_id,closure:w.data.review_closure};
    const closure={reason:'review_pr_terminal',source_message_id:rule.source_message_id,authorization_ref:rule.evidence_ref,
      pr:p,owner_thread_id:t.owner_id,executor_thread_id:actor,evidence_ref:input.evidence_ref,native_proof:proof,
      completed_at:this.c.now(),prior_review_status:t.status,review_work_completed:t.status==='complete',
      note:'Review scope ended because its PR merged or closed; unfinished review steps are superseded, not claimed as performed.'};
    const decision=randomUUID(),contract={...t.contract,retired:true,review_closure:closure};
    this.c.db.prepare('INSERT INTO rt_decisions VALUES (?,?,?,?,?,?,?)').run(decision,t.task_id,t.context_rev,t.plan_rev,'complete',json({reason:closure.reason,evidence_refs:[input.evidence_ref,p.evidence_ref],terminal_review_completion:closure}),this.c.now());
    this.c.db.prepare('INSERT INTO rt_contracts VALUES (?,?,?,?,?)').run(t.task_id,t.contract_rev+1,json(contract),rule.source_message_id,this.c.now());
    this.c.db.prepare("UPDATE rt_tasks SET status='complete',mode='paused',dirty=0,wake_at=NULL,first_pending_at=NULL,contract=?,contract_rev=contract_rev+1,mode_source=?,updated_at=? WHERE task_id=?").run(json(contract),rule.source_message_id,this.c.now(),t.task_id);
    this.c.db.prepare("UPDATE rt_events SET disposition='superseded',decision_id=? WHERE task_id=? AND disposition IS NULL").run(decision,t.task_id);
    this.c.db.prepare("UPDATE rt_waits SET state='resolved',reason='review_pr_terminal',updated_at=? WHERE task_id=?").run(this.c.now(),t.task_id);
    this.c.db.prepare("UPDATE work_items SET state='completed',data=?,revision=revision+1,updated_at=? WHERE id=?").run(json({...w.data,review_closure:closure}),this.c.now(),t.task_id);
    return {completed:true,task_id:t.task_id,closure,archive_required:true};
  });}
}

// Only this saved terminal-review scope extends archive ownership to Review Queue.
// Native quiescence, pending-action, delivery, runtime-context and receipt guards remain.
export function reviewClosureArchiveActor(control,kind,taskId,payload,evidence={},actor) {
  if(kind!=='archive'||payload?.purpose!=='review_pr_terminal')return false;
  const service=new ReviewClosure(control),x=service.identity(taskId),rule=service.policy?.terminal_pr_completion;
  return !!(rule?.enabled&&x?.w.data.review_closure&&x.t.status==='complete'&&x.t.mode==='paused'&&
    payload.thread_id===x.t.owner_id&&payload.source_message_id===rule.source_message_id&&
    x.w.data.review_closure.source_message_id===rule.source_message_id&&
    [control.work.config.threads?.main,service.policy.owner_thread_id,x.t.owner_id].filter(Boolean).includes(actor??evidence.executor_thread_id));
}
