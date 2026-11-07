import {publishWaitObservations} from './wait-observation.mjs';
import {eventWakeReason} from './owner-wake.mjs';
import {renewVerifiedWaits} from './wait-renewal.mjs';
import {routeOwnerInputs,queueOwnerHealth} from './owner-delivery.mjs';
import {NativeServices} from './native-services.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical,fingerprint} from './reactive-state.mjs';
import {Mailbox,renderPrompt} from './mailbox.mjs';
import {shellQuote} from './instance.mjs';
import {mailTaskIds} from './reactive-ownership.mjs';
import {SourceRate,sourceInterval} from './source-rate.mjs';
import {DesktopLoader} from './desktop-loader.mjs';
import {readMacActivity,idleNavigationAllowed,validateIdleNavigationPolicy} from './mac-activity.mjs';
import {scopeActionReasons} from './scope-exclusions.mjs';

const exec=promisify(execFile);
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([k])=>!['checked_at','evidence_ref','snapshot_file','head_before','head_after'].includes(k)).map(([k,v])=>[k,semantic(v)])):value;

export async function collectPullRequest(root,{repository,pr_number},{run=exec}={}) {
  const directory=join(root,'observations','runtime');mkdirSync(directory,{recursive:true});
  const id=randomUUID(),feedbackFile=join(directory,`${id}-feedback.json`),prFile=join(directory,`${id}-pr.json`);
  const common=['--repo',repository,'--pr',String(pr_number)];
  const results=await Promise.allSettled([
    run(process.execPath,[join(root,'runtime/fetch-review-feedback.mjs'),...common,'--output',feedbackFile],{timeout:45000,maxBuffer:4*1024*1024}),
    run(process.execPath,[join(root,'runtime/fetch-pr-state.mjs'),...common,'--output',prFile],{timeout:45000,maxBuffer:4*1024*1024}),
  ]);
  const failed=results.filter(r=>r.status==='rejected');if(failed.length)throw new Error(failed.map(r=>r.reason.message).join('; '));
  const feedback=JSON.parse(readFileSync(feedbackFile,'utf8')),pr=JSON.parse(readFileSync(prFile,'utf8'));
  if(feedback.head_sha!==pr.head_sha||feedback.pr?.updated_at!==pr.updated_at||feedback.pr?.state!==pr.state||feedback.pr?.draft!==pr.draft)
    throw new Error('PR moved during collection; preserve old evidence and refresh');
  return {pr,feedback,data:semantic({pr,reviews:feedback.reviews,review_comments:feedback.review_comments,issue_comments:feedback.issue_comments,review_threads:feedback.review_threads}),
    evidence_ref:feedbackFile,observed_at:Math.min(Date.parse(pr.checked_at),Date.parse(feedback.checked_at))};
}

export function wakePrompt(root,task,wake,checkpoint) {
  const events=checkpoint.events??[],reasons=[...new Set(events.map(eventWakeReason))];
  const reason=reasons.slice(0,3).join('；')+(reasons.length>3?`；另有 ${reasons.length-3} 项变化`:'');
  const lane=task.contract.service_lane,batch=events.find(e=>e.type==='service_batch_ready')?.payload?.batch_id;
  const protocol=lane?'NATIVE_SERVICES.md':'REACTIVE.md';
  return `[workflow-event:${wake.id}]
${lane==='maintenance'?'工作流维护 · ':''}${task.task_id}｜${reason||'有待处理事项'}
按 ${join(root,protocol)} 执行 begin → checkpoint → decide → finish；首次使用或规则变化时读取协议。${lane?`领取 service_begin 批次 ${batch??'见 checkpoint'}，先结束批次，再 cycle_complete/finish。`:''}
根据最新 checkpoint 推进下一步并保存结果。${checkpoint.schedule_runs?.length?'本轮定时结果用 cycle_complete 结束。':''}${task.contract.task_kind==='exploration'?'探索结果按 WORK_TASKS.md 保存 task report。':''}
${lane?'':'评估、测试或研究产出实质结果时，按 RESULT_FOLLOWTHROUGH.md 提交 task report 与结构化 followups；无可执行发现也记录明确结论。'}
${lane?'':'等待 PR/事件时按 OWNER_WAITS.md 报告结构化阻塞；知道下次行动时间时，在 decide(wait) 中提交带时区的 next_action_at，之前不接收自动唤醒。'}
${lane?'维护间隔以 daily-review/config.json 为准。':'涉及交付时按 OWNER_DELIVERY.md；需要决策或重要完成时通知工作中心。'}
入口：node ${shellQuote(join(root,'workflow.mjs'))} runtime op（JSON stdin 或 --file）
${JSON.stringify({task_id:task.task_id,wake_id:wake.id})}`;
}

export class ReactiveDriver {
  constructor({root,control,queue,config,capability,now=()=>Date.now(),collector=collectPullRequest,quotaReader,readActivity,desktopLoader,log=v=>process.stdout.write(JSON.stringify(v)+'\n')}) {
    this.root=root;this.control=control;this.state=control.reactive;this.queue=queue;this.config=config;
    this.capability=capability;this.now=now;this.collector=collector;this.log=log;
    this.polling=new Set();this.delivering=new Set();this.jobs=new Set();
    this.rate=new SourceRate(control.db,{now,readQuota:quotaReader});
    this.readActivity=readActivity??(()=>readMacActivity({now:this.now}));this.desktopLoader=desktopLoader;
  }
  configurePolls() {
    const subjects=new Map(),registry=this.control.taskRegistry();
    const watches=this.control.db.prepare('SELECT pr_key,task_id,owner_id FROM lifecycle_prs WHERE retired=0').all();
    for(const task of this.state.tasks().filter(t=>['active','shadow'].includes(t.mode)&&t.status!=='complete')) {
      const sources=new Map((task.contract.pull_requests??[]).map(pr=>[`${pr.repository}#${pr.pr_number}`,pr]));
      // Artifact registration is source metadata, not a change to the user's goal.
      for(const watch of watches.filter(w=>w.task_id===task.task_id && w.owner_id===task.owner_id)) {
        const match=watch.pr_key.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
        if(match && this.config.repositories.includes(match[1]) && !sources.has(watch.pr_key))
          sources.set(watch.pr_key,{repository:match[1],pr_number:Number(match[2])});
      }
      for(const pr of sources.values()) {
        if(!this.config.repositories.includes(pr.repository)||!/^[\w.-]+\/[\w.-]+$/.test(pr.repository)||!Number.isSafeInteger(pr.pr_number)||pr.pr_number<1)
          throw new Error('PR source is outside the verified instance repository scope');
        if(scopeActionReasons(registry,'merge',task.task_id,{pr_url:`https://github.com/${pr.repository}/pull/${pr.pr_number}`}).includes('scope_excluded_by_actual_user'))continue;
        const subject=`${pr.repository}#${pr.pr_number}`;
        if(!subjects.has(subject))subjects.set(subject,{...pr,task_ids:[]});
        subjects.get(subject).task_ids.push(task.task_id);
      }
    }
    for(const row of this.control.db.prepare("SELECT w.task_id,w.condition FROM rt_waits w JOIN rt_tasks t ON t.task_id=w.task_id WHERE w.state='waiting' AND t.mode IN ('active','shadow') AND json_extract(w.condition,'$.condition.kind')='pr_state'").all()){
      const key=JSON.parse(row.condition).condition.pr_key,match=key.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
      if(!match||!this.config.repositories.includes(match[1]))continue;
      let source=subjects.get(key);
      if(!source){source={repository:match[1],pr_number:Number(match[2]),task_ids:[]};subjects.set(key,source);}
      if(!source.task_ids.includes(row.task_id)){
        source.task_ids.push(row.task_id);source.observer_task_ids=[...(source.observer_task_ids??[]),row.task_id];
      }
    }
    this.control.atomic(()=>{
    for(const row of this.control.db.prepare('SELECT subject FROM rt_polls WHERE enabled=1').all())if(!subjects.has(row.subject))this.control.db.prepare('UPDATE rt_polls SET enabled=0 WHERE subject=?').run(row.subject);
    for(const [subject,config]of subjects){
      const primary=config.task_ids.map(id=>this.state.task(id)).find(t=>['active','shadow'].includes(t.mode)&&t.status!=='complete')??this.state.task(config.task_ids[0]);
      this.control.db.prepare('INSERT INTO rt_polls(subject,task_id,config,next_at,enabled) VALUES (?,?,?,?,1) ON CONFLICT(subject) DO UPDATE SET task_id=excluded.task_id,config=excluded.config,enabled=1 WHERE task_id<>excluded.task_id OR config<>excluded.config OR enabled<>1').run(subject,primary.task_id,canonical(config),this.now());
    }
    });
  }
  async poll(row) {
    const task=this.state.task(row.task_id);if(!task||!['active','shadow'].includes(task.mode)||task.status==='complete')return;
    if(this.rate.paused())return;
    try {
      const result=await this.collector(this.root,JSON.parse(row.config));
      const event=this.state.atomic(()=>{
        const config=JSON.parse(row.config),tasks=(config.task_ids??[task.task_id]).map(id=>this.state.task(id)).filter(t=>t&&['active','shadow'].includes(t.mode)&&t.status!=='complete');
        if(!tasks.length)return {changed:false};
        const owners=tasks.filter(t=>!config.observer_task_ids?.includes(t.task_id));
        if(owners.some(t=>t.mode==='active')){
          this.control.feedback.ingest(result.feedback);
          const owner=owners.find(t=>t.mode==='active');
          if(!this.control.db.prepare('SELECT 1 FROM lifecycle_prs WHERE pr_key=?').get(row.subject))this.control.lifecycle.track({...config,task_id:owner.task_id,owner_thread_id:owner.owner_id,authorization_ref:owner.authorization_ref});
          this.control.lifecycle.observe(result.pr,{feedbackCollected:true});
        }
        const events=tasks.map(t=>this.state.ingestInside({event_id:`github:${row.subject}:${result.observed_at}:${fingerprint(result.data)}:${t.task_id}`,task_id:t.task_id,source:'github',subject:row.subject,
          type:'pr_changed',observed_at:result.observed_at,payload:result.data,evidence_ref:result.evidence_ref}));
        return {changed:events.some(e=>e.changed),context_rev:events[0].context_rev};
      });
      const unchanged=event.changed?0:row.unchanged+1,running=result.pr.ci?.checks?.some(c=>c.status!=='completed');
      const minimum=sourceInterval(this.config,this.control.db.prepare('SELECT COUNT(*) AS n FROM rt_polls WHERE enabled=1').get().n);
      const maximum=result.pr.state==='open'?Math.max(minimum,60000):Math.max(minimum,this.config.poll_max_ms);
      const delay=running||event.changed?minimum:Math.min(maximum,minimum*2**Math.min(3,Math.floor(unchanged/5)));
      this.control.db.prepare('UPDATE rt_polls SET next_at=?,failures=0,unchanged=?,last_error=NULL,last_success_at=? WHERE subject=?').run(this.now()+delay,unchanged,this.now(),row.subject);
      this.rate.success();
      if(event.changed)this.log({event:'source_changed',task_id:task.task_id,subject:row.subject,context_rev:event.context_rev});
    }catch(error){
      const failures=row.failures+1,delay=Math.min(this.config.poll_max_ms,this.config.poll_min_ms*2**Math.min(failures,4));
      const limited=await this.rate.observe(error),next=limited??this.now()+delay;
      const message=limited?'GitHub read quota exhausted; shared source reads wait until the recorded reset':error.message;
      this.control.db.prepare('UPDATE rt_polls SET failures=?,next_at=?,last_error=? WHERE subject=?').run(failures,next,message,row.subject);
      this.state.diagnostic(`source:${row.subject}`,{error:message,failures,next_check_at:next});
    }
  }
  bridgeLegacy() {
    const notices=this.control.db.prepare("SELECT * FROM work_notices WHERE state='pending'").all();
    if(notices.length){const m=new Mailbox(join(this.root,'mailbox.sqlite'));try{for(const n of notices){
      const task=this.control.work.get(n.task_id),payload=JSON.parse(n.payload);
      if(task?.state==='candidate'||payload.catalog_owner_needed&&task?.state==='accepted'&&!task.owner_thread_id||payload.result_followup_decision)
        m.enqueue({key:n.key,lane:'inbox',kind:'decision',payload});
      if(payload.task_completed)m.enqueue({key:n.key,lane:'inbox',kind:'important_completion',payload});
      this.control.db.prepare("UPDATE work_notices SET state='delivered' WHERE key=?").run(n.key);
    }}finally{m.close();}}
    const handoffs=this.control.db.prepare("SELECT * FROM rt_handoffs WHERE state='pending'").all();
    if(handoffs.length){const m=new Mailbox(join(this.root,'mailbox.sqlite'));try{for(const h of handoffs){
      m.enqueue({key:h.key,lane:'coordinator',kind:'event',payload:JSON.parse(h.payload)});
      this.control.db.prepare("UPDATE rt_handoffs SET state='delivered' WHERE key=?").run(h.key);
    }}finally{m.close();}}
    if(this.config.owner_delivery){
      const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
      try{publishWaitObservations({mailbox:m,state:this.state});routeOwnerInputs({root:this.root,control:this.control,mailbox:m,now:this.now});queueOwnerHealth({control:this.control,mailbox:m,now:this.now});}finally{m.close();}
      return;
    }
    const path=join(this.root,'mailbox.sqlite');if(!existsSync(path))return;
    const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');
    try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='mail'").get())return;
      for(const row of db.prepare("SELECT * FROM mail WHERE lane='coordinator' AND state='pending' ORDER BY seq").all()){
        const p=JSON.parse(row.payload),tasks=mailTaskIds(p).map(id=>this.state.task(id));
        if(!tasks.length||tasks.some(t=>!t||t.mode!=='active'))continue;
        for(const task of tasks)this.state.ingest({event_id:`legacy:${row.item_key}:${task.task_id}`,task_id:task.task_id,source:'legacy_mailbox',subject:`mail:${row.item_key}`,
          type:row.kind,observed_at:row.created_at,payload:p,evidence_ref:`${path}#${row.item_key}`,debounce_ms:0});
        db.prepare("UPDATE mail SET state='reactive' WHERE item_key=? AND state='pending'").run(row.item_key);
      }
    }finally{db.close();}
  }
  evidence(task) {
    const registry=this.control.taskRegistry();
    return {verified_at:new Date(this.now()).toISOString(),scope_authorized:true,authorization_ref:task.authorization_ref,
      policy_version:registry?.policy_version??'reactive-v2',current_policy_version:registry?.policy_version??'reactive-v2',stopped:false,
      operation_project_verified:true,operation_project_id:task.contract.project_id,owner_matches:true,owner_thread_id:task.owner_id,
      native_queue_only:true,event_wake_authorized:true,queue_compatibility_verified:this.capability?.verified===true,
      queue_compatibility_ref:this.capability?.evidence_digest};
  }
  async deliver(task) {
    if(this.capability?.verified!==true){this.state.diagnostic('native-queue',{reason:'Desktop consumption must be verified before activation'});return;}
    try{
      if(this.state.waitPolicy.blocked(task.task_id))return {delivered:false,reason:'owner_next_action_not_due'};
      const existing=this.state.openWake(task.task_id);
      if(existing&&existing.task_id!==task.task_id)return;
      if(existing&&existing.state!=='reserved'){
        this.state.diagnostic(`pending:${task.task_id}`,{state:existing.state,queue_id:existing.queue_id??null,
          reason:existing.transport!=='native_queue'?'Reconcile the old direct-driver receipt through desktop tools':'Waiting for native consumption or owner checkpoint; no automatic resend'});return;
      }
      if(task.wake_at===null||task.wake_at>this.now())return;
      const reserved=existing?{reserved:true,wake:existing}:this.state.reserveQueuedWake(task.task_id);
      if(!reserved.reserved)return;
      const wake=reserved.wake,prompt=wake.prompt??wakePrompt(this.root,task,wake,this.state.checkpoint(task.task_id));
      this.queue.validate(task.owner_id,prompt);
      this.control.db.prepare('UPDATE rt_wakes SET prompt=COALESCE(prompt,?) WHERE id=?').run(prompt,wake.id);
      const evidence=this.evidence(task);
      const prepared=this.control.prepare({key:wake.id,kind:'task_queue',task_id:task.task_id,
        payload:{thread_id:task.owner_id,wake_id:wake.id,starts_heavy_work:false,prompt,...(task.contract.scope_keys?{scope_keys:task.contract.scope_keys}:{})},evidence});
      if(prepared.allowed===false){this.state.diagnostic(`delivery:${task.task_id}`,prepared);return;}
      const claim=this.control.claim({key:wake.id,owner:'reactive-runtime',evidence:this.evidence(this.state.task(task.task_id))});
      if(!claim.claimed){this.state.diagnostic(`delivery:${task.task_id}`,claim);return;}
      try{
        const receipt=await this.queue.enqueue(task.owner_id,claim.payload.prompt);
        this.control.settle({key:wake.id,attempt_id:claim.attempt_id,outcome:'sent',evidence_ref:`native-queue:${receipt.queue_id}`,native_result:{queue_receipt:receipt}});
        this.log({event:'native_queue_accepted',task_id:task.task_id,wake_id:wake.id,queue_id:receipt.queue_id,execution_verified:false});
      }catch(error){
        this.control.settle({key:wake.id,attempt_id:claim.attempt_id,outcome:error.not_sent?'not_sent':'uncertain',
          error_class:error.not_sent?'invalid_before_send':null,evidence_ref:`native-queue-error:${error.message}`});
        this.state.diagnostic(`delivery:${task.task_id}`,{error:error.message,uncertain:!error.not_sent});
      }
    }catch(error){this.state.diagnostic(`owner:${task.task_id}`,{error:error.message});}
  }
  async deliverInbox() {
    if(!this.config.inbox||this.capability?.verified!==true)return;
    if(this.config.inbox.delivery_mode==='on_request')return {delivered:false,reason:'inbox_on_request'};
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{
      if(this.config.service_tasks && !this.config.owner_delivery)this.requestNativeQueueChecks(m);
      const ids=new Set([...this.state.tasks().filter(t=>t.mode==='active').map(t=>t.task_id),...this.control.work.list().map(t=>t.id)]);
      for(const row of m.db.prepare("SELECT item_key,payload FROM mail WHERE lane='inbox' AND state='pending'").all()){
        const payload=JSON.parse(row.payload);
        if(payload.catalog_candidate&&this.control.work.get(payload.task_id)?.state!=='candidate')m.db.prepare("UPDATE mail SET state='superseded' WHERE item_key=? AND state='pending'").run(row.item_key);
        if(payload.catalog_owner_needed&&this.control.work.get(payload.task_id)?.owner_thread_id)m.db.prepare("UPDATE mail SET state='superseded' WHERE item_key=? AND state='pending'").run(row.item_key);
      }
      m.reconcileInbox();
      const result=m.reserveQueuedInbox(ids);if(!result.reserved)return;
      const batch=result.batch,path=join(this.root,'batches',`${batch.id}.json`),prompt=renderPrompt(batch,path);
      this.queue.validate(this.config.inbox.thread_id,prompt);m.setPrompt(batch.id,prompt);
      mkdirSync(join(this.root,'batches'),{recursive:true});writeFileSync(path,JSON.stringify(m.get(batch.id),null,2)+'\n',{mode:0o600});
      const permitted=m.authorizeQueueSend(batch.id);if(!permitted.send)return;
      try{
        const receipt=await this.queue.enqueue(this.config.inbox.thread_id,prompt);
        m.delivery(batch.id,{outcome:'sent',receipt:{queue_receipt:receipt,execution_verified:false}});
      }catch(error){m.delivery(batch.id,{outcome:error.not_sent?'not_sent':'uncertain',receipt:{error:error.message,verified_not_sent:error.not_sent===true}});}
    }catch(error){this.state.diagnostic('inbox',{error:error.message});}
    finally{m.close();}
  }
  async deliverControls() {
    if(!this.config.control_lanes||this.capability?.verified!==true)return;
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{
      this.requestNativeQueueChecks(m);
      const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
      m.admitSchedules({daily_review:read(join(this.root,'daily-review/config.json')),weekly_research:read(join(this.root,'weekly-research/config.json'))});
      this.control.db.exec('CREATE TABLE IF NOT EXISTS rt_control_tick (id INTEGER PRIMARY KEY, bucket INTEGER NOT NULL)');
      const bucket=Math.floor(this.now()/600000),old=this.control.db.prepare('SELECT bucket FROM rt_control_tick WHERE id=1').get();
      if(old?.bucket!==bucket){m.tick();this.control.db.prepare('INSERT OR REPLACE INTO rt_control_tick VALUES (1,?)').run(bucket);}
      for(const [lane,binding]of Object.entries(this.config.control_lanes)){
        if(lane==='inbox'&&this.config.inbox?.delivery_mode==='on_request')continue;
        const result=m.reserveQueuedLane(lane);if(!result.reserved)continue;
        const batch=result.batch,path=join(this.root,'batches',`${batch.id}.json`),prompt=renderPrompt(batch,path);
        this.queue.validate(binding.thread_id,prompt);m.setPrompt(batch.id,prompt);
        mkdirSync(join(this.root,'batches'),{recursive:true});writeFileSync(path,JSON.stringify(m.get(batch.id),null,2)+'\n',{mode:0o600});
        if(!m.authorizeQueueSend(batch.id).send)continue;
        try{
          const receipt=await this.queue.enqueue(binding.thread_id,prompt);
          m.delivery(batch.id,{outcome:'sent',receipt:{queue_receipt:receipt,execution_verified:false}});
          this.log({event:'control_queue_accepted',lane,batch_id:batch.id,queue_id:receipt.queue_id});
        }catch(error){m.delivery(batch.id,{outcome:error.not_sent?'not_sent':'uncertain',receipt:{error:error.message,verified_not_sent:error.not_sent===true}});}
      }
    }finally{m.close();}
  }
  requestNativeQueueChecks(mailbox) {
    const delay=this.config.desktop_loader?.enabled?300000:60000;
    for(const wake of this.control.db.prepare("SELECT * FROM rt_wakes WHERE state='queued' AND created_at<=?").all(this.now()-delay)){
      const task=this.state.task(wake.task_id);if(task?.mode!=='active'||wake.transport!=='native_queue')continue;
      const key=`native-queue-check:${wake.id}`;
      if(mailbox.db.prepare('SELECT 1 FROM mail WHERE item_key=?').get(key))continue;
      const members=this.state.openWake(task.task_id)?.member_ids??[task.task_id];
      mailbox.enqueue({key,lane:'coordinator',kind:'configuration',payload:{event:'native_queue_consumption_check',affected_task_ids:members,
        owner_thread_id:task.owner_id,wake_id:wake.id,queue_id:wake.queue_id,evidence_ref:`control.sqlite#rt_wakes/${wake.id}`,
        instruction:'Read the current wake and a fresh native wait_threads/read_thread snapshot. This is one bounded check, not permission to resend. If already running/finished, preserve it and acknowledge this observation. If the owner is active, awaiting approval/input, held or archived, preserve current work/settings; do not steer or duplicate a dispatch. If it is notLoaded, preserve the exact queue ID and record that background consumption is pending. Never open a thread URL, navigate_to_codex_page, activate an App/window, or switch/restore a selected chat as an automatic recovery step. Only use a separately verified non-UI native background capability. Do not send another message, use --resume or direct App Server control. Record actual loaded/consumed/busy status separately; no routine user notification.',user_notification_required:false}});
    }
  }
  async loadPendingDesktopChats() {
    let policy=this.config.desktop_loader;
    const configPath=join(this.root,'runtime.json');
    if(policy?.enabled&&existsSync(configPath)){
      let live;try{live=JSON.parse(readFileSync(configPath,'utf8')).desktop_loader;}catch{return {opened:false,reason:'idle_configuration_unavailable'};}
      if(!live?.enabled)return {opened:false,reason:'automatic_desktop_navigation_disabled'};
      if(live.mode!==policy.mode||live.authorization_ref!==policy.authorization_ref||live.bundle_id!==policy.bundle_id)
        return {opened:false,reason:'idle_policy_changed_restart_required'};
      policy={...policy,min_idle_ms:live.min_idle_ms};
    }
    if(!policy?.enabled||policy.mode!=='idle_only'||this.capability?.verified!==true)
      return {opened:false,reason:'automatic_desktop_navigation_disabled'};
    validateIdleNavigationPolicy(policy);
    const at=this.now();
    if(this.desktopCheckAt!==undefined&&at-this.desktopCheckAt<policy.check_interval_ms)return {opened:false,reason:'activity_check_interval'};
    this.desktopCheckAt=at;
    const db=this.control.db;
    db.exec(`CREATE TABLE IF NOT EXISTS rt_idle_desktop_loads (
      wake_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,queue_id TEXT NOT NULL,
      attempts INTEGER NOT NULL,last_attempt_at INTEGER NOT NULL,next_at INTEGER NOT NULL,result TEXT NOT NULL);`);
    const last=db.prepare('SELECT MAX(last_attempt_at) at FROM rt_idle_desktop_loads').get().at;
    if(last!==null&&at-last<policy.open_interval_ms)return {opened:false,reason:'desktop_open_interval'};
    const eligible=wake=>{
      if(!wake||wake.state!=='queued'||!wake.queue_id||wake.transport!=='native_queue'||wake.turn_id)return false;
      if((this.config.queue?.blocked_thread_ids??[]).includes(wake.owner_id)||wake.owner_id===this.config.inbox?.thread_id&&this.config.inbox.delivery_mode==='on_request')return false;
      if(db.prepare("SELECT 1 FROM rt_wakes WHERE owner_id=? AND state IN ('running','claimed','uncertain')").get(wake.owner_id))return false;
      if(wake.batch_id)return this.queuedDesktopBatches().some(b=>b.id===wake.id&&b.owner_id===wake.owner_id&&b.queue_id===wake.queue_id);
      const open=this.state.openWake(wake.task_id),members=open?.member_ids??[];
      if(open?.id!==wake.id||!members.length)return false;
      try{
        for(const id of members){
          const task=this.state.task(id);
          if(!task||task.owner_id!==wake.owner_id||task.mode!=='active'||['complete','needs_decision'].includes(task.status)||
            policy.excluded_task_ids?.includes(id)||task.contract.retired||this.state.waitPolicy.blocked(id))return false;
          this.state.assertQueueOwner(task);
        }
      }catch{return false;}
      return !db.prepare("SELECT 1 FROM rt_wakes WHERE owner_id=? AND state IN ('running','claimed','uncertain')").get(wake.owner_id);
    };
    const candidates=db.prepare(`SELECT w.* FROM rt_wakes w LEFT JOIN rt_idle_desktop_loads d ON d.wake_id=w.id
      WHERE w.state='queued' AND (d.next_at IS NULL OR d.next_at<=?) ORDER BY COALESCE(d.last_attempt_at,0),w.created_at,w.id`).all(at);
    candidates.push(...this.queuedDesktopBatches().filter(b=>!db.prepare('SELECT 1 FROM rt_idle_desktop_loads WHERE wake_id=? AND next_at>?').get(b.id,at)));
    candidates.sort((a,b)=>(db.prepare('SELECT last_attempt_at FROM rt_idle_desktop_loads WHERE wake_id=?').get(a.id)?.last_attempt_at??0)-
      (db.prepare('SELECT last_attempt_at FROM rt_idle_desktop_loads WHERE wake_id=?').get(b.id)?.last_attempt_at??0)||a.created_at-b.created_at);
    const wake=candidates.find(w=>at-w.created_at>=policy.queue_grace_ms&&eligible(w));if(!wake)return {opened:false,reason:'no_eligible_queued_owner'};
    const current=()=>wake.batch_id?this.queuedDesktopBatches().find(b=>b.id===wake.id):db.prepare('SELECT * FROM rt_wakes WHERE id=?').get(wake.id);
    const policyUnchanged=()=>{
      if(!existsSync(configPath))return true;
      try{const live=JSON.parse(readFileSync(configPath,'utf8')).desktop_loader;
        return live?.enabled===true&&live.mode===policy.mode&&live.authorization_ref===policy.authorization_ref&&
          live.bundle_id===policy.bundle_id&&live.min_idle_ms===policy.min_idle_ms;
      }catch{return false;}
    };
    let activity;
    try{activity=await this.readActivity();}catch(error){return {opened:false,reason:'activity_unavailable',error:error.message};}
    if(!idleNavigationAllowed(activity,policy,this.now()))return {opened:false,reason:'user_active_or_idle_unconfirmed'};
    if(!eligible(current()))return {opened:false,reason:'queued_owner_changed'};
    const previous=db.prepare('SELECT attempts FROM rt_idle_desktop_loads WHERE wake_id=?').get(wake.id),attempts=(previous?.attempts??0)+1;
    const next=this.now()+Math.min(1800000,policy.retry_interval_ms*2**Math.min(attempts-1,3));
    db.prepare(`INSERT INTO rt_idle_desktop_loads VALUES (?,?,?,?,?,?,?) ON CONFLICT(wake_id) DO UPDATE SET
      attempts=excluded.attempts,last_attempt_at=excluded.last_attempt_at,next_at=excluded.next_at,result=excluded.result`)
      .run(wake.id,wake.owner_id,wake.queue_id,attempts,this.now(),next,JSON.stringify({state:'opening',activity}));
    this.desktopLoader??=new DesktopLoader({bundle_id:policy.bundle_id,now:this.now,read_activity:this.readActivity});
    let result;
    try{result=await this.desktopLoader.open(wake.owner_id,{idle_policy:policy,
      can_open:()=>policyUnchanged()&&eligible(current())});}
    catch(error){result={open_requested:false,reason:'desktop_open_failed',error:error.message};}
    db.prepare('UPDATE rt_idle_desktop_loads SET result=? WHERE wake_id=?').run(JSON.stringify(result),wake.id);
    if(result.open_requested){
      this.log({event:'idle_desktop_open_requested',task_id:wake.task_id,wake_id:wake.id,queue_id:wake.queue_id,
        idle_ms:result.activity?.idle_ms,execution_verified:false});
    }else this.state.diagnostic(`desktop-loading:${wake.id}`,result);
    return {opened:result.open_requested===true,wake_id:wake.id,...result};
  }

  queuedDesktopBatches() {
    const file=join(this.root,'mailbox.sqlite'),owner=this.control.discovery.config.threads?.discovery;
    if(!owner||!existsSync(file))return [];
    const db=new DatabaseSync(file,{readOnly:true});
    try{return db.prepare("SELECT b.* FROM batches b JOIN lane_state l ON l.lane=b.lane WHERE b.lane='discovery' AND b.state='sent' AND l.enabled=1").all().flatMap(b=>{
      const snapshot=JSON.parse(b.snapshot),receipt=b.receipt&&JSON.parse(b.receipt),queue=receipt?.queue_receipt;
      const scan=this.control.discovery.batch(snapshot.items?.[0]?.payload?.batch_id);
      if(snapshot.delivery_transport!=='native_queue'||scan?.state!=='pending'||!queue?.queue_id||queue.thread_id!==owner)return [];
      return [{id:`batch:${b.id}`,batch_id:b.id,owner_id:owner,queue_id:queue.queue_id,state:'queued',transport:'native_queue',created_at:b.created_at}];
    });}finally{db.close();}
  }

  async discoveryTick() {
    if(this.capability?.verified!==true)return;
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{
      this.control.discovery.reconcileMailbox(m);
      this.control.work.followthrough.advance(this.state,{queue_compatibility_verified:true});
      const resultWork=this.control.work.followthrough.pending();
      if(!this.control.discovery.sources().some(s=>s.enabled)&&!resultWork.reviews.length&&!resultWork.owners.length&&!this.control.work.creation.pending().length)return;
      const due=this.control.discovery.enqueueDue(m,this.root);
      if(due.reason==='discovery_role_not_bound'){this.state.diagnostic('discovery',{reason:due.reason});return;}
      if(!this.control.discovery.config.threads?.discovery)return;
      for(const item of m.db.prepare("SELECT item_key,payload FROM mail WHERE lane='discovery' AND state='pending'").all()){
        if(this.control.discovery.batch(JSON.parse(item.payload).batch_id)?.state==='invalidated')
          m.db.prepare("UPDATE mail SET state='superseded' WHERE item_key=? AND state='pending'").run(item.item_key);
      }
      const reserved=m.reserveQueuedInbox(null,'discovery');if(!reserved.reserved)return;
      const b=reserved.batch,scan=this.control.discovery.batch(b.snapshot.items[0].payload.batch_id);
      if(!scan||scan.state!=='pending'){m.releaseReservation(b.id);return;}
      const prompt=scan.prompt;m.setPrompt(b.id,prompt);this.queue.validate(this.control.discovery.config.threads.discovery,prompt);
      if(!m.authorizeQueueSend(b.id).send)return;
      try{const receipt=await this.queue.enqueue(this.control.discovery.config.threads.discovery,prompt);
        m.delivery(b.id,{outcome:'sent',receipt:{queue_receipt:receipt,execution_verified:false}});
      }catch(error){m.delivery(b.id,{outcome:error.not_sent?'not_sent':'uncertain',receipt:{error:error.message,verified_not_sent:error.not_sent===true}});}
    }catch(error){this.state.diagnostic('discovery',{error:error.message});}
    finally{m.close();}
  }
  launch(set,key,fn){
    if(set.has(key))return;set.add(key);
    const job=Promise.resolve().then(fn).catch(error=>this.log({event:'runtime_error',key,error:error.message})).finally(()=>{set.delete(key);this.jobs.delete(job);});
    this.jobs.add(job);
  }
  async tick({wait=false}={}) {
    this.control.scheduler.tick();
    this.configurePolls();renewVerifiedWaits({root:this.root,control:this.control,now:this.now});new NativeServices({root:this.root,control:this.control,config:this.config,now:this.now}).bridge();this.bridgeLegacy();this.state.expireWaits();
    if(!this.rate.paused())for(const row of this.control.db.prepare("SELECT p.* FROM rt_polls p JOIN rt_tasks t ON t.task_id=p.task_id WHERE p.enabled=1 AND p.next_at<=? AND t.mode IN ('active','shadow') AND t.status<>'complete' ORDER BY p.next_at").all(this.now())){
      if(this.polling.size>=(this.config.poll_connections??2))break;
      this.launch(this.polling,row.subject,()=>this.poll(row));
    }
    const owners=new Map();
    for(const task of this.state.tasks().filter(t=>t.mode==='active'&&t.wake_at!==null))if(!owners.has(task.owner_id))owners.set(task.owner_id,task);
    for(const [owner,candidate]of owners){
      const reserved=this.control.db.prepare("SELECT task_id FROM rt_wakes WHERE owner_id=? AND state='reserved'").get(owner);
      const task=reserved?this.state.task(reserved.task_id):candidate;
      this.launch(this.delivering,`owner:${owner}`,()=>this.deliver(task));
    }
    this.launch(this.delivering,'control:lanes',()=>this.config.control_lanes?this.deliverControls():this.deliverInbox());
    this.launch(this.delivering,'desktop:loading',()=>this.loadPendingDesktopChats());
    this.launch(this.delivering,'control:discovery',()=>this.discoveryTick());
    if(wait)await Promise.allSettled([...this.jobs]);
  }
  async close(){await Promise.allSettled([...this.jobs]);}
}
