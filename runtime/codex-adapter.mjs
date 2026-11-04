import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';

// Use the installed CLI's supported proxy, never a private App database or socket guess.
export class CodexAdapter extends EventEmitter {
  constructor({ command = ['codex','app-server','proxy'], timeout_ms = 15000, spawnProcess = spawn, now = () => Date.now() } = {}) {
    super();
    if (!Array.isArray(command) || !command.length || command.some(x=>typeof x!=='string'||!x)) throw new Error('Adapter command must be an argument array');
    this.command=command;this.timeout=timeout_ms;this.spawnProcess=spawnProcess;this.now=now;this.requests=new Map();this.sequence=0;
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting=this.open();
    try { await this.connecting; } finally { this.connecting=null; }
  }
  async open() {
    const proc=this.spawnProcess(this.command[0],this.command.slice(1),{stdio:['pipe','pipe','pipe']});
    this.proc=proc;
    this.lines=createInterface({input:proc.stdout});
    this.lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{this.fail(new Error('Invalid JSON from Codex app-server'));return;}
      if(message.method && message.id!==undefined) {
        // Server approval/tool requests are not responses to our own request IDs.
        // Preserve native authority: expose them, never silently approve them.
        this.emit('serverRequest',message);
      } else if (message.id!==undefined) {
        const pending=this.requests.get(message.id);if(!pending)return;
        clearTimeout(pending.timer);this.requests.delete(message.id);
        if(message.error){const error=new Error(message.error.message??'App-server error');error.rpc_code=message.error.code;pending.reject(error);}
        else pending.resolve(message.result);
      } else if(message.method && message.id===undefined) this.emit('notification',message);
    });
    proc.stderr.on('data',chunk=>this.emit('diagnostic',String(chunk).slice(-4096)));
    proc.on('error',error=>{if(this.proc===proc)this.fail(error);});
    proc.on('exit',(code,signal)=>{if(this.proc===proc)this.fail(new Error(`Codex transport closed (${code??signal})`));});
    try {
      this.initialization=await this.request('initialize',{clientInfo:{name:'workflow-kit',title:'Workflow Kit',version:'0.3.0'},capabilities:{experimentalApi:true}},true);
      this.send({method:'initialized'});this.ready=true;
    }catch(error){if(this.proc===proc)this.close();throw error;}
  }
  fail(error) {
    this.ready=false;
    for(const pending of this.requests.values()){clearTimeout(pending.timer);pending.reject(error);}
    this.requests.clear();this.emit('disconnected',error);
  }
  send(value) {
    if(!this.proc?.stdin?.writable)throw new Error('Codex transport is not writable');
    this.proc.stdin.write(JSON.stringify(value)+'\n');
  }
  async request(method,params,initializing=false) {
    if(!initializing)await this.connect();
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.requests.delete(id);reject(new Error(`App-server request timed out: ${method}`));},this.timeout);
      this.requests.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.requests.delete(id);reject(error);}
    });
  }
  async observe(task,{subscribe=true}={}) {
    const id=task.owner_id, read=await this.request('thread/read',{threadId:id});
    let thread=read.thread,settings=null;
    if(thread?.id!==id)throw new Error('App-server returned a different owner');
    if(thread.projectId!==task.contract.project_id || realpathSync(thread.cwd)!==realpathSync(task.contract.workspace))
      throw new Error('Native project or workspace differs from the task contract');
    if(!['idle','notLoaded'].includes(thread.status?.type))return {thread_id:id,status:thread.status?.type,checked_at:this.now(),busy:true};
    if(subscribe){
      settings=await this.request('thread/resume',{threadId:id,excludeTurns:true});
      if(settings.thread?.id!==id || settings.thread.projectId!==thread.projectId ||
          realpathSync(settings.cwd)!==realpathSync(thread.cwd) || thread.model && settings.model!==thread.model ||
          thread.reasoningEffort!=null && settings.reasoningEffort!==thread.reasoningEffort)
        throw new Error('Resume changed the owner model, effort, project or workspace');
      thread=settings.thread;
    }
    const responses=await Promise.allSettled([
      this.request('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'summary'}),
      this.request('thread/queue/list',{threadId:id,limit:1}),
      this.request('thread/backgroundTerminals/list',{threadId:id,limit:1}),
    ]);
    for(const r of responses)if(r.status==='rejected')throw new Error(`Cannot verify idle owner: ${r.reason.message}`);
    const [turns,queue,jobs]=responses.map(r=>r.value),latest=turns.data?.[0];
    if(!Array.isArray(queue.data)||!Array.isArray(jobs.data))throw new Error('Unknown queued input or background job state');
    return {thread_id:id,project_id:thread.projectId,workspace:realpathSync(thread.cwd),status:thread.status.type,
      turn_id:latest?.id,turn_status:latest?.status,checked_at:this.now(),queued_input:queue.data.length>0||!!queue.nextCursor,
      background_job_running:jobs.data.length>0||!!jobs.nextCursor,approval_pending:(thread.status.activeFlags??[]).length>0,
      permissions_preserved:!!settings && settings.approvalPolicy!=null && !!settings.sandbox,
      permission_snapshot:settings?{approval_policy:settings.approvalPolicy,sandbox:settings.sandbox}:null,
      native_thread_snapshot:{thread,latestTurn:latest,checked_at:new Date(this.now()).toISOString()}};
  }
  async start(task,wake,prompt) {
    // This API has no conditional idle-start field. Recheck immediately and have
    // the receiver claim its exact wake before work; never pretend this is a CAS.
    const current=await this.observe(task);
    if(current.busy || current.turn_id!==wake.preflight_turn || current.status!=='idle' ||
      current.queued_input!==false || current.background_job_running!==false || current.approval_pending!==false)
      {const error=new Error('Owner changed before delivery');error.not_sent=true;throw error;}
    return this.request('turn/start',{threadId:task.owner_id,clientUserMessageId:wake.id,
      turnTrigger:'workflow_event',input:[{type:'text',text:prompt,text_elements:[]}]});
  }
  async findDelivery(task,wake) {
    // Read-only recovery: a matching persisted marker proves delivery, silence does not.
    let cursor=null;
    for(let page=0;page<5;page++) {
      const result=await this.request('thread/turns/list',{threadId:task.owner_id,limit:20,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});
      const turn=result.data?.find(t=>(t.items??[]).some(i=>i.type==='userMessage' && JSON.stringify(i.content).includes(`[workflow-event:${wake.id}]`)));
      if(turn)return {found:true,turn};
      cursor=result.nextCursor;if(!cursor)break;
    }
    return {found:false,not_sent_verified:false};
  }
  close() {
    this.ready=false;this.lines?.close();const proc=this.proc;this.proc=null;proc?.stdin?.end();proc?.kill();
    for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(new Error('Adapter closed'));}this.requests.clear();
  }
}
