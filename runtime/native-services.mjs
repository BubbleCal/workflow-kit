import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Mailbox} from './mailbox.mjs';

// Delivery and maintenance are ordinary task owners. The mailbox is retained
// only for immutable input batches and existing progress/side-effect receipts.
export class NativeServices {
  constructor({root,control,config,now=()=>Date.now()}){this.root=root;this.control=control;this.config=config;this.now=now;}
  task(lane){
    const id=this.config.service_tasks?.[lane],task=id&&this.control.reactive.task(id);
    if(!id)return null;
    if(!['coordinator','maintenance'].includes(lane)||!task||task.contract.service_lane!==lane)
      throw new Error('Native service must bind an accepted task with the exact service lane');
    return task;
  }
  bridge(){
    if(!this.config.service_tasks)return;
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{
      const read=name=>{const p=join(this.root,name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):undefined;};
      m.admitSchedules({daily_review:read('daily-review/config.json'),weekly_research:read('weekly-research/config.json')});
      for(const item of this.control.lifecycle.reconcile())m.enqueue(item);
      for(const input of this.config.service_inputs??[]){
        if(!input.id||!input.authorization_ref||!Number.isSafeInteger(input.interval_ms)||input.interval_ms<60000||
          !['coordinator','maintenance'].includes(input.lane))throw new Error('Bounded authorized service input required');
        if(this.task(input.lane)?.mode!=='active')continue;
        if(m.db.prepare("SELECT 1 FROM mail WHERE lane=? AND state IN ('pending','in_batch') AND json_extract(payload,'$.service_input_id')=?").get(input.lane,input.id))continue;
        const cutoff=Math.floor(this.now()/input.interval_ms)*input.interval_ms;
        m.enqueue({key:`service-input:${input.id}:${cutoff}`,lane:input.lane,kind:input.lane==='maintenance'?'workflow_recovery':'configuration',
          payload:{...input.payload,service_input_id:input.id,authorization_ref:input.authorization_ref,window_end:new Date(cutoff).toISOString(),user_notification_required:false}});
      }
      for(const lane of Object.keys(this.config.service_tasks)){
        const task=this.task(lane);if(task.mode!=='active'||['complete','needs_decision'].includes(task.status)||this.control.reactive.openWake(task.task_id))continue;
        const cadence=lane==='maintenance'?m.maintenanceCadence():null;
        if(cadence && this.now()<cadence.eligible_at)continue;
        let batch=m.db.prepare("SELECT id FROM batches WHERE lane=? AND state='reserved' AND json_extract(snapshot,'$.service_task_id')=?").get(lane,task.task_id);
        if(batch)batch=m.get(batch.id);
        else {const result=m.reserveQueuedLane(lane,{service_task_id:task.task_id});if(!result.reserved)continue;batch=result.batch;}
        const held=this.control.db.prepare("SELECT 1 FROM rt_waits WHERE task_id=? AND state='waiting' AND json_extract(condition,'$.expires_at')>?").get(task.task_id,this.now());
        if(task.status==='waiting'&&held)continue;
        this.control.reactive.ingest({event_id:`service:${batch.id}:${task.wake_seq}`,task_id:task.task_id,source:'service_mailbox',subject:`service:${lane}`,
          type:'service_batch_ready',observed_at:batch.created_at,payload:{batch_id:batch.id,lane,service_task_id:task.task_id,attempt:task.wake_seq},
          evidence_ref:`mailbox.sqlite#batches/${batch.id}`,debounce_ms:0});
      }
    }finally{m.close();}
  }
  begin({task_id,owner_thread_id,wake_id,batch_id}){
    const task=this.control.reactive.task(task_id),lane=task?.contract.service_lane;
    if(!task||this.task(lane)?.task_id!==task_id||task.owner_id!==owner_thread_id)throw new Error('Original service task owner required');
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{return m.beginService(batch_id,{task_id,owner_thread_id,wake_id,control_db:this.control.db});}finally{m.close();}
  }
  assertFinished(task_id,wake_id){
    const task=this.control.reactive.task(task_id);if(!task?.contract.service_lane)return;
    const wake=this.control.reactive.openWake(task_id);if(wake?.id!==wake_id)throw new Error('Service completion needs its actual wake');
    const events=this.control.db.prepare("SELECT payload FROM rt_events WHERE task_id=? AND event_id IN (SELECT value FROM json_each(?)) AND source='service_mailbox'").all(task_id,JSON.stringify(wake.event_ids));
    const m=new Mailbox(join(this.root,'mailbox.sqlite'),{now:this.now});
    try{if(!events.length||events.some(e=>m.get(JSON.parse(e.payload).batch_id)?.state!=='finished'))throw new Error('Finish the actual service batch before completing its cycle');}finally{m.close();}
  }
}
