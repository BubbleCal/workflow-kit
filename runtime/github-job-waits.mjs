import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Mailbox} from './mailbox.mjs';
import {publishWaitObservations} from './wait-observation.mjs';
import {sourceInterval} from './source-rate.mjs';

const execute=promisify(execFile);
const jobSubject=/^github:([\w.-]+\/[\w.-]+):job([1-9]\d*)$/;
export function githubJobIdentity(fact,repositories){
 const m=fact.subject.match(jobSubject),data=JSON.parse(fact.data);
 if(!m||!repositories.includes(m[1])||String(data.job_id)!==m[2]||data.repository&&data.repository!==m[1])return null;
 return{repository:m[1],job_id:m[2]};
}

// Read one exact registered job. A completed job is not necessarily successful.
export async function collectGitHubJob(root,{repository,job_id},{run=execute,now=()=>Date.now()}={}){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||!/^[1-9]\d*$/.test(job_id))throw Error('Exact GitHub job identity required');
 const {stdout}=await run('gh',['api',`repos/${repository}/actions/jobs/${job_id}`],{timeout:15000,maxBuffer:4*1024*1024});
 const job=JSON.parse(stdout),url=`https://api.github.com/repos/${repository}/actions/jobs/${job_id}`;
 if(!Number.isSafeInteger(job.id)||String(job.id)!==job_id||job.url!==url)throw Error('GitHub job response identity does not match registered source');
 let state;
 if(['queued','waiting','pending','requested'].includes(job.status))state='pending';
 else if(job.status==='in_progress')state='running';
 else if(job.status==='completed'&&['success','neutral','skipped','failure','cancelled','timed_out','action_required','stale','startup_failure'].includes(job.conclusion))state=['success','neutral','skipped'].includes(job.conclusion)?'complete':'failed';
 else throw Error('GitHub job has unknown status or missing terminal conclusion');
 const observed_at=now(),directory=join(root,'observations','runtime');mkdirSync(directory,{recursive:true});
 const evidence_ref=join(directory,`${randomUUID()}-github-job.json`);
 writeFileSync(evidence_ref,JSON.stringify({source:'GitHub Actions job API',observed_at:new Date(observed_at).toISOString(),job},null,2)+'\n');
 return{observed_at,evidence_ref,data:{job_id,state,repository,conclusion:job.conclusion??null,run_id:job.run_id,head_sha:job.head_sha,html_url:job.html_url}};
}

export class GitHubJobWaits {
 constructor({root,control,config,rate,now=()=>Date.now(),collector=collectGitHubJob}){Object.assign(this,{root,control,config,rate,now,collector});}
 stale(mailbox,task,wait,fact,reason){
  const key=`job-source-stale:${task.task_id}:${wait.updated_at}:${fact?.fact_key??'missing'}`;
  const payload={event:'job_wait_source_stale',task_id:task.task_id,owner_thread_id:task.owner_id,fact_key:fact?.fact_key??JSON.parse(wait.condition).condition?.fact_key,
   reason,evidence_ref:fact?.evidence_ref??'control.sqlite#rt_waits/'+task.task_id,user_notification_required:false,
   recovery:'Read the exact registered job from its owning source. Persist the real state with runtime op wait_observe (same fact_key, kind=job, subject and job_id). For an unsupported source, register its actual producer or reconcile the original wait with the owner; do not invent a terminal result, repeat the job, or clear holds.'};
  const prior=this.control.db.prepare('SELECT data FROM rt_diagnostics WHERE key=?').get(key);
  if(!prior)this.control.reactive.diagnostic(key,payload);
  mailbox.enqueue({key,lane:'maintenance',kind:'workflow_recovery',payload:prior?JSON.parse(prior.data):payload});
 }
 sources(){
  const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now}),sources=new Map();
  try{
   publishWaitObservations({mailbox:m,state:this.control.reactive});
   for(const wait of this.control.db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()){
    const task=this.control.reactive.task(wait.task_id);if(!task||!['active','shadow'].includes(task.mode)||task.status==='complete'||task.contract.retired)continue;
    const spec=JSON.parse(wait.condition),facts=new Map();
    if(spec.condition?.kind==='job'){
     const fact=m.db.prepare("SELECT * FROM wait_facts WHERE fact_key=? AND kind='job'").get(spec.condition.fact_key??'');
     if(fact&&fact.subject===spec.condition.subject&&String(JSON.parse(fact.data).job_id)===String(spec.condition.job_id))facts.set(fact.fact_key,fact);
     else if(spec.expires_at<=this.now())this.stale(m,task,wait,null,'Registered job source is missing or mismatched');
    }
    for(const expected of spec.facts??[])for(const fact of m.db.prepare("SELECT * FROM wait_facts WHERE subject=? AND kind='job'").all(expected.subject)){
     const bound=this.control.db.prepare('SELECT data FROM rt_facts WHERE task_id=? AND subject=?').get(task.task_id,expected.subject);
     if(bound&&String(JSON.parse(bound.data).job_id)===String(JSON.parse(fact.data).job_id))facts.set(fact.fact_key,fact);
    }
    for(const fact of facts.values()){
     if(!['pending','running'].includes(JSON.parse(fact.data).state))continue;
     const id=githubJobIdentity(fact,this.config.repositories??[]);
     if(!id){if(fact.expires_at<=this.now())this.stale(m,task,wait,fact,'No authorized exact GitHub job collector matches this source');continue;}
     const key=`github-job:${id.repository}:${id.job_id}`;
     if(!sources.has(key))sources.set(key,{kind:'github_job',...id,task_ids:[],facts:[]});
     const source=sources.get(key);if(!source.task_ids.includes(task.task_id))source.task_ids.push(task.task_id);
     if(!source.facts.some(f=>f.fact_key===fact.fact_key))source.facts.push({fact_key:fact.fact_key,subject:fact.subject});
    }
   }
   return sources;
  }finally{m.close();}
 }
 async poll(row){
  if(this.rate.paused())return;
  try{
   const config=JSON.parse(row.config),current=this.sources().get(row.subject);if(!current)return;
   if(config.repository!==current.repository||config.job_id!==current.job_id)return;
   const result=await this.collector(this.root,current);
   if(!Number.isFinite(result.observed_at)||this.now()-result.observed_at>60000||result.observed_at>this.now()+5000||String(result.data.job_id)!==current.job_id||result.data.repository!==current.repository)throw Error('Fresh matching job source required');
   const target=this.sources().get(row.subject);if(!target)return;
   const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
   try{
    m.atomic(()=>{for(const fact of target.facts)m.waits.observe({...fact,kind:'job',data:result.data,observed_at:new Date(result.observed_at).toISOString(),expires_at:new Date(this.now()+3600000).toISOString(),evidence_ref:result.evidence_ref});});
    publishWaitObservations({mailbox:m,state:this.control.reactive});
   }finally{m.close();}
   const delay=sourceInterval(this.config,this.control.db.prepare('SELECT COUNT(*) n FROM rt_polls WHERE enabled=1').get().n);
   this.control.db.prepare('UPDATE rt_polls SET next_at=?,failures=0,last_error=NULL,last_success_at=? WHERE subject=?').run(this.now()+delay,this.now(),row.subject);this.rate.success();
  }catch(error){
   const failures=row.failures+1,limited=await this.rate.observe(error),next=limited??this.now()+Math.min(this.config.poll_max_ms,this.config.poll_min_ms*2**Math.min(failures,4));
   this.control.db.prepare('UPDATE rt_polls SET failures=?,next_at=?,last_error=? WHERE subject=?').run(failures,next,error.message.slice(0,1000),row.subject);
   this.control.reactive.diagnostic(`source:${row.subject}`,{error:error.message.slice(0,1000),failures,next_check_at:next});
   if(failures>=3){const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});try{
    for(const taskId of JSON.parse(row.config).task_ids){const task=this.control.reactive.task(taskId),wait=this.control.db.prepare("SELECT * FROM rt_waits WHERE task_id=? AND state='waiting'").get(taskId);if(!task||!['active','shadow'].includes(task.mode)||!wait)continue;
     for(const f of JSON.parse(row.config).facts){const fact=m.db.prepare('SELECT * FROM wait_facts WHERE fact_key=?').get(f.fact_key);if(fact?.expires_at<=this.now())this.stale(m,task,wait,fact,`GitHub job source unavailable after ${failures} attempts: ${error.message.slice(0,500)}`);}
    }
   }finally{m.close();}}
  }
 }
}
