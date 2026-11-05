import {createHash,randomUUID} from 'node:crypto';
import {verifyExecutionProof} from './native-queue.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required=(v,n)=>{if(typeof v!=='string'||!v.trim())throw new Error(`${n} is required`);};
const arr=value=>Array.isArray(value)?value:[];

export function sourceReadPlan(source,window) {
  const s=source.scope,requests=[];
  if(source.kind==='linear'){
    requests.push({tool:'linear_list_issues',arguments:{...(s.project?{project:s.project}:{}),...(s.team?{team:s.team}:{}),
      assignee:s.assignee_id??s.assignee??'me',updatedAt:window.from,orderBy:'updatedAt',limit:50,includeArchived:false,
      fields:['id','uuid','title','description','url','updatedAt','status','statusType','assigneeId','projectId','teamId']}});
    for(const issueId of arr(s.issue_ids))requests.push({tool:'linear_list_comments',arguments:{issueId,orderBy:'updatedAt',limit:100}});
    return {requests,followups:'Follow all cursors. Read comments on newly returned and watched issues; do not assume a comment necessarily updates its parent issue timestamp.'};
  }
  if(source.kind==='slack'){
    for(const channel of arr(s.channel_ids).length?s.channel_ids:[null])requests.push({tool:s.access==='private'?'slack_search_public_and_private':'slack_search_public',arguments:{
      filters:[channel?`in:<#${channel}>`:null,s.with_user_id?`with:<@${s.with_user_id}>`:null].filter(Boolean).join(' '),keywords:[],natural_language_query:'',after:String(Date.parse(window.from)/1000),before:String(Date.parse(window.to)/1000),
      content_types:'messages',sort:'timestamp',sort_dir:'asc',limit:20,include_context:true}});
    return {requests,followups:'Follow all result cursors and read relevant full threads with slack_read_thread. Preserve root thread identity and reply/edit versions. Private access must match the recorded explicit user grant.'};
  }
  if(source.kind==='calendar')return {requests:[{tool:'google_calendar_search_events',arguments:{calendar_id:s.calendar_id,time_min:window.to,
    time_max:new Date(Date.parse(window.to)+(s.lookahead_days??7)*86400000).toISOString(),timezone_str:s.timezone??'Asia/Shanghai',max_results:100}}],
    followups:'Follow every page and read changed events. Under the existing meeting-preparation authorization, reconcile preparation schedules 45 minutes before meetings, preserving exclusions, language preferences, existing owners and event IDs. This does not authorize modifying meetings or sending messages. Read MEETING_PREP.md; discovery only maintains preparation schedules and publishes occurrences, never writes the meeting brief. Classify unchanged/excluded events as ignore with evidence; bind changed accepted meetings to their original task.'};
  if(source.kind==='codex')return {requests:[{tool:'list_threads',arguments:{mode:'history',source:'codex',hostId:s.host_id??'local',archived:false,limit:50}}],followups:'Filter by the exact configured project before reading actual human requests. Ignore control/discovery chats and other projects; never infer scope from a title. Preserve existing owners and running jobs. Register verified existing work without starting or duplicating it; source listing alone is not implementation authority.'};
  for(const id of arr(s.page_ids))requests.push({tool:'notion_fetch',arguments:{id,include_discussions:true}});
  for(const view_url of arr(s.view_urls))requests.push({tool:'notion_query_data_sources',arguments:{data:{mode:'view',view_url,page_size:100,is_archived:false}}});
  return {requests,followups:'Check Notion tool access, fetch source/view metadata when required, follow cursors and inspect truncation/unknown blocks. Read relevant discussions. Do not silently treat missing subtrees as no change.'};
}

// Discovery collects configured source changes only. Code, papers, blogs and
// benchmarks belong to ordinary exploration tasks, never to this service role.
export class DiscoveryStore {
  constructor(db,{config,work,reactive,now=()=>Date.now()}={}){
    this.db=db;this.config=config??{};this.work=work;this.reactive=reactive;this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS discovery_sources (
      source_id TEXT PRIMARY KEY,kind TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT '{}',interval_ms INTEGER NOT NULL,last_success_at INTEGER,next_at INTEGER NOT NULL DEFAULT 0,
      authority TEXT,health TEXT);
      CREATE TABLE IF NOT EXISTS discovery_batches (
        id TEXT PRIMARY KEY,state TEXT NOT NULL,snapshot TEXT NOT NULL,prompt TEXT,mail_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,finished_at INTEGER,generation INTEGER NOT NULL DEFAULT 1,next_at INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS one_discovery_scan ON discovery_batches((1)) WHERE state IN ('pending','running');
      CREATE TABLE IF NOT EXISTS discovery_pages (
        page_key TEXT PRIMARY KEY,batch_id TEXT NOT NULL,source_id TEXT NOT NULL,request_index INTEGER NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discovery_observations (
        observation_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,entity_key TEXT NOT NULL,item_key TEXT NOT NULL,version TEXT NOT NULL,
        data TEXT NOT NULL,disposition TEXT,task_id TEXT,decision TEXT,created_at INTEGER NOT NULL);
    `);
    for(const [kind,interval] of [['linear',300000],['slack',300000],['notion',900000],['codex',600000],['calendar',3600000]])
      db.prepare('INSERT OR IGNORE INTO discovery_sources(source_id,kind,interval_ms) VALUES (?,?,?)').run(kind,kind,interval);
  }
  atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  sources(){return this.db.prepare('SELECT * FROM discovery_sources ORDER BY source_id').all().map(s=>({...s,scope:JSON.parse(s.scope),authority:s.authority?JSON.parse(s.authority):null}));}
  configure({source_id,enabled,scope={},interval_ms,source_message_id,actual_human_verified,evidence_ref}){
    required(source_message_id,'source configuration authorization');required(evidence_ref,'scope evidence');
    if(actual_human_verified!==true)throw new Error('Source configuration requires actual user authorization');
    const old=this.sources().find(s=>s.source_id===source_id);if(!old)throw new Error('Unknown configured discovery source');
    if(enabled){
      if(old.kind==='linear'&&!scope.project&&!scope.team&&!(scope.assignment_only===true&&typeof scope.assignee_id==='string'&&scope.assignee_id))throw new Error('Configure a specific Linear project or team');
      if(old.kind==='slack'&&((!arr(scope.channel_ids).length&&!/^U[A-Z0-9]+$/.test(scope.with_user_id??''))||arr(scope.channel_ids).some(id=>!/^([CGD])[A-Z0-9]+$/.test(id))))throw new Error('Configure exact Slack channel/DM IDs');
      if(old.kind==='slack'&&scope.access==='private'&&scope.private_access_authorized!==true)throw new Error('Private Slack source access needs its explicit user grant');
      if(old.kind==='slack'&&scope.access!=='private'&&arr(scope.channel_ids).some(id=>!id.startsWith('C')))throw new Error('Private channels/DMs cannot be queried through the public source');
      if(old.kind==='slack'&&scope.with_user_id&&scope.professional_only!==true)throw new Error('User-directed Slack discovery must be limited to professional work');
      if(old.kind==='codex'&&(scope.project_id!==this.config.scope.project_id||scope.host_id!=='local'))throw new Error('Codex discovery must use this exact local project');
      if(old.kind==='calendar'&&(!scope.calendar_id||!scope.preparation_authorization_ref))throw new Error('Calendar discovery needs a specific calendar and original preparation authorization');
      if(old.kind==='notion'&&!arr(scope.page_ids).length&&!arr(scope.view_urls).length)throw new Error('Configure specific Notion pages or saved views');
    }
    const interval=interval_ms??old.interval_ms;if(!Number.isSafeInteger(interval)||interval<60000)throw new Error('A discovery source interval must be at least one minute');
    return this.atomic(()=>{
      this.db.prepare('UPDATE discovery_sources SET enabled=?,revision=revision+1,scope=?,interval_ms=?,authority=?,next_at=?,health=NULL WHERE source_id=?')
        .run(Number(enabled===true),JSON.stringify(scope),interval,JSON.stringify({source_message_id,evidence_ref}),this.now(),source_id);
      // Already queued native messages cannot be recalled. Their begin/ingest
      // checks reject the obsolete snapshot before another source read occurs.
      this.db.prepare("UPDATE discovery_batches SET state='invalidated',finished_at=? WHERE state IN ('pending','running','checkpointed')").run(this.now());
      this.db.prepare("UPDATE discovery_observations SET disposition='scope_changed',decision=? WHERE source_id=? AND disposition IS NULL")
        .run(JSON.stringify({source_message_id,evidence_ref,reason:'Source scope changed before classification'}),source_id);
      return this.sources().find(s=>s.source_id===source_id);
    });
  }
  calendarFollowups(){
    if(!this.work.calendarRule()?.enabled)return [];
    return this.db.prepare("SELECT id FROM work_items WHERE state='accepted' AND json_extract(data,'$.meeting_preparation.policy_key')='accept_calendar_preparation'").all().map(({id})=>{
      const t=this.work.get(id),p=t.data.meeting_preparation,s=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_schedules'").get()?this.db.prepare('SELECT status FROM rt_schedules WHERE id=?').get(p.schedule_id):null;
      return {task_id:id,title:t.data.title,owner_thread_id:t.owner_thread_id,schedule_id:p.schedule_id,prep_at:p.prep_at,needs_owner:!t.owner_thread_id,needs_schedule:!s,source_message_id:p.source_message_id};
    }).filter(t=>t.needs_owner||t.needs_schedule);
  }
  batch(id){const b=this.db.prepare('SELECT * FROM discovery_batches WHERE id=?').get(id);return b?{...b,snapshot:JSON.parse(b.snapshot),calendar_followups:this.calendarFollowups(),
    pages:this.db.prepare('SELECT source_id,request_index,data FROM discovery_pages WHERE batch_id=? ORDER BY rowid').all(id).map(p=>({...p,data:JSON.parse(p.data)}))}:null;}
  checkBatch(id){
    const b=this.batch(id);if(!b||!['pending','running'].includes(b.state))throw new Error('Discovery batch is unavailable or its source scope changed');
    for(const source of b.snapshot.sources){const current=this.sources().find(s=>s.source_id===source.source_id);
      if(!current?.enabled||current.revision!==source.revision)throw new Error('Discovery source was disabled or changed');}
    return b;
  }
  reconcileMailbox(mailbox){
    // A scan's durable finish can precede its mailbox ACK if the process exits.
    // Reconcile that receipt before incrementing a checkpoint generation.
    for(const row of this.db.prepare("SELECT id FROM discovery_batches WHERE state IN ('finished','checkpointed')").all()){
      const scan=this.batch(row.id),mail=mailbox.db.prepare('SELECT batch_id FROM mail WHERE item_key=?').get(scan.mail_key);
      if(!mail?.batch_id)continue;
      const batch=mailbox.get(mail.batch_id);
      if(batch?.state==='finished')continue;
      if(batch?.prompt!==scan.prompt||!['sending','sent','uncertain','running'].includes(batch?.state))throw new Error('Discovery finish receipt disagrees with its native queue batch');
      mailbox.begin(batch.id);mailbox.finish(batch.id,{processed_keys:[scan.mail_key],note:'reconciled durable source scan finish'});
    }
  }
  enqueueDue(mailbox,root){
    const sources=this.sources().filter(s=>s.enabled&&s.next_at<=this.now());
    if(!sources.length)return {queued:false,reason:'no_enabled_source_due'};
    if(!this.config.threads?.discovery)return {queued:false,reason:'discovery_role_not_bound'};
    let b=this.db.prepare("SELECT id FROM discovery_batches WHERE state IN ('pending','running') ORDER BY created_at LIMIT 1").get();
    if(b)b=this.batch(b.id);
    const checkpoints=this.db.prepare("SELECT id FROM discovery_batches WHERE state='checkpointed' ORDER BY next_at,created_at").all().map(r=>this.batch(r.id));
    const unfinished=s=>{const current=this.sources().find(c=>c.source_id===s.source_id);return current.last_success_at===null||current.last_success_at<Date.parse(s.window.to);};
    const owned=new Set(checkpoints.flatMap(c=>c.snapshot.sources.filter(unfinished).map(s=>s.source_id)));
    const fresh=sources.filter(s=>!owned.has(s.source_id));
    const resume=checkpoints.find(c=>c.next_at<=this.now()&&c.snapshot.sources.some(s=>unfinished(s)&&sources.some(d=>d.source_id===s.source_id)));
    if(!b&&resume&&(!fresh.length||resume.next_at<Math.min(...fresh.map(s=>s.next_at))))b=resume;
    if(!b&&!fresh.length)return {queued:false,reason:'discovery_checkpoint_backoff'};
    if(!b)b=this.atomic(()=>{
      const id=randomUUID(),to=new Date(this.now()).toISOString();
      const snapshot={sources:fresh.map(s=>{const window={from:new Date(Math.max(0,(s.last_success_at??this.now()-86400000)-120000)).toISOString(),to};
        return {...s,window,plan:sourceReadPlan(s,window)};})};
      this.db.prepare("INSERT INTO discovery_batches(id,state,snapshot,mail_key,created_at) VALUES (?,'pending',?,?,?)").run(id,JSON.stringify(snapshot),`discovery:${id}:1`,this.now());return this.batch(id);
    });
    if(b.state==='running')return {queued:false,reason:'discovery_in_progress'};
    if(b.state==='checkpointed'){
      if(b.next_at>this.now())return {queued:false,reason:'discovery_checkpoint_backoff'};
      this.db.prepare("UPDATE discovery_batches SET state='pending',generation=generation+1,prompt=NULL,mail_key=? WHERE id=?").run(`discovery:${b.id}:${b.generation+1}`,b.id);
      b=this.batch(b.id);
    }
    const prompt=`[workflow-discovery:${b.id}:${b.generation}]\nRun one source-only discovery scan for this instance. Read ${root}/DISCOVERY.md. Use the App's connected tools; do not open a session client. First obtain a real read_thread proof and call workflow discovery begin with batch_id and generation. If invalidated, stop without reading sources. Then read the batch plan. Handle its authorized calendar_followups first using task request_owner/prepare_owner, bind_owner and start; this is scheduled setup, not early brief preparation. Afterwards resume saved source cursors and collect only configured source changes, including authorized calendar preparation schedule upkeep, ingest pages and classify observations as an existing task, a candidate, or irrelevant. Preserve cursors and raw evidence. Do not explore code, papers or blogs, run benchmarks, implement work, or manufacture user authorization. Such work belongs to ordinary accepted tasks. For calendar observations read full event details and pass meeting to classify; the saved preparation policy accepts only its scope and exclusions. Follow MEETING_PREPARATION_INTAKE.md to provision authorized owners and schedule them without notifying main. For an accepted unowned task, follow WORK_TASKS.md to create its owner only under the saved explicit creation policy. Finish the batch only with complete source coverage and durable dispositions; otherwise checkpoint the partial cursor. No routine message to the main conversation. Batch: ${b.id}; generation: ${b.generation}.`;
    this.db.prepare('UPDATE discovery_batches SET prompt=COALESCE(prompt,?) WHERE id=?').run(prompt,b.id);
    const queued=mailbox.enqueue({key:b.mail_key,lane:'discovery',kind:'source_scan',payload:{batch_id:b.id,text:prompt}});
    return {...queued,batch_id:b.id};
  }
  begin({batch_id,generation,native_proof}){
    return this.atomic(()=>{
      const b=this.batch(batch_id);if(!b||b.generation!==generation)throw new Error('Stale discovery generation');
      verifyExecutionProof(native_proof,{thread_id:this.config.threads.discovery,workspace:this.config.thread_workspaces?.discovery??this.config.scope.project_root,prompt:b.prompt,now:this.now()});
      if(b.state==='invalidated')return {...b,invalidated:true};
      this.checkBatch(batch_id);
      this.db.prepare("UPDATE discovery_batches SET state='running' WHERE id=?").run(batch_id);return this.checkBatch(batch_id);
    });
  }
  ingest({batch_id,generation,source_id,page_key,request_index=0,cursor=null,observations=[],complete,next_cursor,evidence_ref}){
    required(page_key,'page identity');required(evidence_ref,'actual connector evidence');
    return this.atomic(()=>{
      const b=this.checkBatch(batch_id);if(b.state!=='running')throw new Error('Begin the actual discovery run before ingesting');
      if(b.generation!==generation)throw new Error('Stale discovery generation');
      const source=b.snapshot.sources.find(s=>s.source_id===source_id);if(!source)throw new Error('Source is not in this scan');
      if(!Number.isInteger(request_index)||request_index<0||request_index>=source.plan.requests.length)throw new Error('Unknown source request stream');
      if(complete!==true&&!next_cursor)throw new Error('Partial source coverage needs a continuation cursor');
      if(complete===true&&next_cursor)throw new Error('A source with a next cursor is not complete');
      const data={observations,complete:complete===true,cursor,next_cursor:next_cursor??null,evidence_ref},digest=hash(data);
      page_key=`${batch_id}:${source_id}:${request_index}:${page_key}`;
      const old=this.db.prepare('SELECT * FROM discovery_pages WHERE page_key=?').get(page_key);
      if(old){if(old.batch_id!==batch_id||old.source_id!==source_id||old.digest!==digest)throw new Error('An ingested page cannot change meaning');return {recorded:false};}
      const previous=b.pages.filter(p=>p.source_id===source_id&&p.request_index===request_index).at(-1)?.data;
      if(previous?.complete || cursor!==(previous?.next_cursor??null))throw new Error('Resume the exact saved source cursor; do not skip or restart a partial stream');
      for(const o of observations){
        for(const k of ['entity_key','item_key','version','scope_key','summary','url'])required(o[k],k);
        const allowed=source.kind==='linear'?[source.scope.project,source.scope.team,source.scope.assignment_only?source.scope.assignee_id:null].filter(Boolean):source.kind==='slack'?[...arr(source.scope.channel_ids),source.scope.with_user_id].filter(Boolean):source.kind==='codex'?[source.scope.project_id]:source.kind==='calendar'?[source.scope.calendar_id]:[...arr(source.scope.page_ids),...arr(source.scope.view_urls)];
        if(source.kind==='linear'&&source.scope.assignment_only&&o.assignee_id!==source.scope.assignee_id)throw new Error('Observation has a different assigned user');
        if(source.kind==='slack'&&source.scope.with_user_id&&(o.relevant_user_id!==source.scope.with_user_id||o.professional_relevance!==true))throw new Error('Observation is outside the user-directed professional scope');
        if(source.kind==='codex'&&(o.project_id!==source.scope.project_id||Object.values(this.config.threads??{}).includes(o.item_key)))throw new Error('Observation is outside ordinary work in this project');
        if(!allowed.includes(o.scope_key))throw new Error('Observation is outside the configured source scope');
        const id=`${source_id}:${source.revision}:${o.item_key}:${o.version}`,stored={...o,evidence_ref,source_kind:source.kind,source_revision:source.revision};
        const previous=this.db.prepare('SELECT data FROM discovery_observations WHERE observation_id=?').get(id);
        if(previous){const prior=JSON.parse(previous.data);if(hash({...prior,evidence_ref:null})!==hash({...stored,evidence_ref:null}))throw new Error('Immutable source version changed');continue;}
        this.db.prepare('INSERT INTO discovery_observations VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?)').run(id,source_id,o.entity_key,o.item_key,o.version,JSON.stringify(stored),this.now());
      }
      this.db.prepare('INSERT INTO discovery_pages VALUES (?,?,?,?,?,?)').run(page_key,batch_id,source_id,request_index,digest,JSON.stringify(data));return {recorded:true};
    });
  }
  classify({observation_id,disposition,reason,evidence_ref,candidate,meeting}){
    required(reason,'discovery judgment');required(evidence_ref,'judgment evidence');
    if(!['existing','candidate','ignore'].includes(disposition))throw new Error('Unknown discovery disposition');
    return this.atomic(()=>{
      const o=this.db.prepare('SELECT * FROM discovery_observations WHERE observation_id=?').get(observation_id);if(!o)throw new Error('Unknown observation');
      if(o.disposition&&!meeting)return {classified:false,task_id:o.task_id};
      const data=JSON.parse(o.data);let task=this.work.taskForSource(o.entity_key);
      const source=this.sources().find(s=>s.source_id===o.source_id);
      if(!source?.enabled||source.revision!==data.source_revision)throw new Error('Source scope is no longer current');
      if(data.source_kind==='calendar' && disposition!=='ignore'){
        const accepted=this.work.prepareCalendarInside(data,meeting??data.meeting);
        if(accepted.excluded){this.db.prepare("UPDATE discovery_observations SET disposition='ignore',decision=? WHERE observation_id=?").run(JSON.stringify({reason:accepted.reason,evidence_ref}),observation_id);return {classified:true,excluded:true};}
        if(accepted.authorized){task=accepted.task;this.db.prepare("UPDATE discovery_observations SET disposition='existing',task_id=?,decision=? WHERE observation_id=?").run(task.id,JSON.stringify({reason:'standing_calendar_preparation',evidence_ref}),observation_id);return {classified:true,task_id:task.id,execution_authorized:task.state==='accepted',owner_required:!task.owner_thread_id,meeting_preparation:task.data.meeting_preparation,next_preparation:accepted.preparation,requires_reschedule:accepted.requires_reschedule??false};}
        if(this.work.calendarRule()?.enabled&&['full_event_required','full_attendance_required'].includes(accepted.reason))throw new Error('Read the full calendar event and pass meeting before classifying preparation');
      }
      if(disposition==='existing'&&!task)throw new Error('Existing-task routing needs an exact registered source identity');
      if(disposition==='candidate'){
        if(!candidate)throw new Error('Describe the candidate work');
        task=this.work.createInside({...candidate,state:'candidate',source:{kind:data.source_kind,key:o.entity_key,url:data.url,evidence_ref}}).task;
        this.work.linkSourceInside(task.id,o.entity_key,{url:data.url,evidence_ref});
        task=this.work.acceptAssignedInside(task,data);
      }
      if(disposition!=='ignore'&&task&&this.reactive.task(task.id))this.reactive.ingestInside({event_id:`discovery:${o.observation_id}`,task_id:task.id,source:data.source_kind,
        subject:o.entity_key,type:'source_changed',observed_at:o.created_at,payload:data,evidence_ref:data.evidence_ref,debounce_ms:0});
      this.db.prepare('UPDATE discovery_observations SET disposition=?,task_id=?,decision=? WHERE observation_id=?')
        .run(disposition,task?.id??null,JSON.stringify({reason,evidence_ref}),observation_id);
      return {classified:true,task_id:task?.id??null,execution_authorized:task?.state==='accepted',owner_required:task?.state==='accepted'&&!task.owner_thread_id};
    });
  }
  finish({batch_id,generation,source_results}){
    return this.atomic(()=>{
      const saved=this.batch(batch_id);if(!saved||saved.generation!==generation)throw new Error('Stale discovery generation');
      if(['finished','checkpointed'].includes(saved.state))return {finished:saved.state==='finished',checkpointed:saved.state==='checkpointed',duplicate:true};
      if(saved.state==='invalidated')throw new Error('Begin the invalidated scan with actual native proof to retire its receipt');
      const b=this.checkBatch(batch_id);if(b.state!=='running')throw new Error('Discovery scan has not begun');
      let allComplete=true,nextAt=Infinity;
      for(const s of b.snapshot.sources){
        const current=this.sources().find(c=>c.source_id===s.source_id);
        if(current.last_success_at!==null&&current.last_success_at>=Date.parse(s.window.to))continue;
        const result=source_results?.find(r=>r.source_id===s.source_id);if(!result)throw new Error('Every source needs a coverage result');
        const pages=b.pages.filter(p=>p.source_id===s.source_id);
        if(result.complete===true){
          if(s.kind==='calendar'&&this.calendarFollowups().length)throw new Error('Bind and schedule authorized calendar follow-ups before completing coverage, or checkpoint the real technical blocker');
          if(result.followups_complete!==true||s.plan.requests.some((_,i)=>!pages.filter(p=>p.request_index===i).at(-1)?.data.complete))throw new Error('A source cursor cannot advance without all request streams and relevant follow-ups');
          const pending=this.db.prepare('SELECT 1 FROM discovery_observations WHERE source_id=? AND disposition IS NULL').get(s.source_id);
          if(pending)throw new Error('Classify source observations before completing the scan');
          this.db.prepare('UPDATE discovery_sources SET last_success_at=?,next_at=?,health=NULL WHERE source_id=?')
            .run(Date.parse(s.window.to),this.now()+s.interval_ms,s.source_id);
        }else{
          allComplete=false;
          required(result.reason,'source failure/partial reason');
          const hasCursor=pages.some(p=>!p.data.complete&&p.data.next_cursor);
          const retry=this.now()+(hasCursor?60000:s.interval_ms);nextAt=Math.min(nextAt,retry);
          this.db.prepare('UPDATE discovery_sources SET next_at=?,health=? WHERE source_id=?').run(retry,JSON.stringify(result),s.source_id);
        }
      }
      this.db.prepare('UPDATE discovery_batches SET state=?,finished_at=?,next_at=? WHERE id=?').run(allComplete?'finished':'checkpointed',allComplete?this.now():null,allComplete?0:nextAt,batch_id);
      return {finished:allComplete,checkpointed:!allComplete};
    });
  }
  status(){return {sources:this.sources(),batches:this.db.prepare("SELECT id,state,created_at FROM discovery_batches WHERE state<>'finished'").all(),
    observations:this.db.prepare('SELECT * FROM discovery_observations ORDER BY created_at DESC LIMIT 100').all().map(o=>({...o,data:JSON.parse(o.data)}))};}
}
