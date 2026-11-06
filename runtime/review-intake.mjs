import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export const reviewKey=url=>{
 const m=String(url??'').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
 if(!m)throw new Error('Use the canonical GitHub PR URL');
 return `review:${m[1].toLowerCase()}#${m[2]}`;
};
export function readReviewIntake(root){if(typeof root!=='string')return null;const p=join(root,'review-queue/config.json');return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;}
export class ReviewIntake {
 constructor(control,policy){this.control=control;this.db=control.db;this.policy=policy;
  this.db.exec('CREATE TABLE IF NOT EXISTS review_queue_selections (pr_key TEXT PRIMARY KEY,day TEXT NOT NULL,data TEXT NOT NULL,selected_at INTEGER NOT NULL)');}
 day(){return new Intl.DateTimeFormat('en-CA',{timeZone:this.policy.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(this.control.now()));}
 status(){return {day:this.day(),limit:this.policy.daily_limit,selections:this.db.prepare('SELECT * FROM review_queue_selections WHERE day=? ORDER BY selected_at,pr_key').all(this.day()).map(r=>({...r,data:JSON.parse(r.data)}))};}
 admit(input){return this.control.atomic(()=>{
  const t=this.control.reactive.task(this.policy.task_id);
  if(!this.policy.enabled||t?.owner_id!==input.owner_thread_id||input.owner_thread_id!==this.policy.owner_thread_id||t.mode!=='active'||t.status==='complete')throw new Error('Only the active Review Queue owner selects PRs');
  if(!['linear_queue','explicit_request','vector_fts'].includes(input.source)||this.policy.sources?.[input.source]?.enabled===false||!input.evidence_ref?.trim())throw new Error('Bind an authorized source and actual evidence');
  const pr=input.pr,key=reviewKey(pr?.url),at=Date.parse(input.checked_at);
  if(!Number.isFinite(at)||at>this.control.now()+5000||this.control.now()-at>300000||pr.state!=='open'||pr.draft!==false||
    !/^[a-f0-9]{40}$/.test(pr.head_sha??'')||!/^[a-f0-9]{40}$/.test(pr.base_sha??'')||!pr.author||pr.author.toLowerCase()===this.policy.github_login.toLowerCase())throw new Error('Fresh open ready PR head/base and another author are required');
  // Recheck eligibility even for an existing admission: a new head can regress.
  if(this.policy.eligibility?.require_ci_passed===true&&
    (pr.ci_passed!==true||pr.ci_complete!==true||pr.ci_head_sha!==pr.head_sha))
    return {admitted:false,reason:'current_head_ci_not_passed',key};
  if(this.policy.eligibility?.require_mergeable===true&&pr.mergeable!==true)
    return {admitted:false,reason:pr.mergeable===false?'merge_conflict':'mergeability_unverified',key};
  const prior=this.db.prepare('SELECT * FROM review_queue_selections WHERE pr_key=?').get(key);
  if(prior)return {admitted:true,new_selection:false,key,day:prior.day,data:JSON.parse(prior.data)};
  const used=this.status().selections.length;
  if(used>=this.policy.daily_limit)return {admitted:false,reason:'daily_review_limit',day:this.day(),limit:this.policy.daily_limit};
  const data={...input,canonical_task_key:key,authorization_ref:this.policy.authorization_ref};
  this.db.prepare('INSERT INTO review_queue_selections VALUES (?,?,?,?)').run(key,this.day(),JSON.stringify(data),this.control.now());
  return {admitted:true,new_selection:true,key,day:this.day(),remaining:this.policy.daily_limit-used-1,data};
 });}
}
export function reviewCreationReasons(control,input){
 const task=control.work.get(input.task_id);
 if(task?.data.source?.review_only===true&&['slack_pr','pr_ready','merge','notion_sync','automation_update'].includes(input.kind))return ['review_only_task_external_action_forbidden'];
 if(input.kind!=='create_thread')return [];
 const policy=readReviewIntake(control.work.config.instance_root);
 if(!policy?.enabled||!(input.evidence?.executor_thread_id===policy.owner_thread_id||task?.data.source?.review_queue_service_task_id===policy.task_id))return [];
 const intake=new ReviewIntake(control,policy),key=input.payload.review_queue_admission_key;
 const selected=typeof key==='string'&&intake.db.prepare('SELECT * FROM review_queue_selections WHERE pr_key=?').get(key);
 if(!selected||key!==input.payload.canonical_task_key||task?.canonical_key!==key)return ['review_queue_selection_required'];
 // An admission is durable across retries, but it grants only one read-only PR task.
 const data=JSON.parse(selected.data);
 if(task.data.source?.review_queue_service_task_id!==policy.task_id||task.data.source?.review_only!==true||
   task.data.pull_requests.length!==1||`review:${task.data.pull_requests[0].repository.toLowerCase()}#${task.data.pull_requests[0].pr_number}`!==key||
   data.pr.url!==task.data.source.pr_url)return ['read_only_review_task_scope_required'];
 return [];
}
