import {ReviewFeedback as FeedbackEvidence} from '../guards/review-feedback.mjs';
export {reviewSurface,reviewSurfaceDigest,pullRequestIdentity} from '../guards/review-feedback.mjs';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new Error(`${name} is required`);};
const fresh=(at,now)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now+5000&&now-Date.parse(at)<=60000;
export class ReviewFeedback extends FeedbackEvidence {
  constructor(db,now){super(db,now);db.exec('CREATE TABLE IF NOT EXISTS feedback_routes(route_key TEXT PRIMARY KEY,repository TEXT,pr_number INTEGER,head TEXT,owner_id TEXT,task_id TEXT,item_keys TEXT,control_action_key TEXT,evidence_ref TEXT)');}
  plan({repository,pr_number,head,owner_thread_id,task_id,implementation_authorized,authorization_ref,observation}) {
    const {snapshot,items}=this.status(repository,pr_number);
    if(!snapshot||snapshot.head!==head||!fresh(snapshot.checked_at,this.now()))return {eligible:false,reason:'fresh_feedback_required'};
    if(items.some(x=>!x.assessment))return {eligible:false,reason:'feedback_assessment_incomplete'};
    const actionable=items.filter(x=>x.assessment?.disposition==='actionable');
    if(!actionable.length)return {eligible:false,reason:'no_assessed_actionable_feedback'};
    required(owner_thread_id,'existing implementation owner');required(task_id,'existing task');
    const keys=actionable.map(x=>x.key),key=`review-fix:${repository}#${pr_number}:${head}:${hash(actionable.map(x=>[x.key,x.digest])).slice(0,20)}`;
    const route=this.db.prepare('SELECT * FROM feedback_routes WHERE route_key=?').get(key);
    if(route)return {eligible:false,reason:'already_routed',route};
    if(implementation_authorized!==true||!authorization_ref)return {eligible:false,reason:'original_implementation_authorization_required',item_keys:keys};
    const o=observation;
    if(!o||o.thread_id!==owner_thread_id||!fresh(o.checked_at,this.now())||!['idle','notLoaded'].includes(o.status)||!['completed','failed','interrupted'].includes(o.turn_status)||!o.turn_id||o.pending_dispatch!==false||o.queued_input!==false||o.background_job_running!==false||o.hold!==false||o.existing_driver!==false)
      return {eligible:false,reason:'preserve_active_queued_or_unverified_owner',item_keys:keys};
    return {eligible:true,key,repository,pr_number,head,owner_thread_id,task_id,item_keys:keys,authorization_ref,requires_ordinary_control_dispatch:true};
  }
  recordRoute({repository,pr_number,head,owner_thread_id,task_id,control_action_key,item_keys,binding_verified,evidence_ref}) {
    required(evidence_ref,'actual route binding evidence');
    const {snapshot,items}=this.status(repository,pr_number);
    const actionable=items.filter(x=>x.assessment?.disposition==='actionable');
    if(!snapshot||snapshot.head!==head||items.some(x=>!x.assessment)||!actionable.length||!Array.isArray(item_keys)||JSON.stringify([...item_keys].sort())!==JSON.stringify(actionable.map(x=>x.key).sort()))throw new Error('Exact current feedback set required');
    const action=this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(control_action_key);
    if(binding_verified!==true||!action||!['dispatch','human_input'].includes(action.kind)||!['claimed','sent','uncertain'].includes(action.state)||action.task_id!==task_id||JSON.parse(action.payload).thread_id!==owner_thread_id)
      throw new Error('A real matching guarded route and semantic binding evidence are required');
    const key=`review-fix:${repository}#${pr_number}:${head}:${hash(actionable.map(x=>[x.key,x.digest])).slice(0,20)}`;
    const prior=this.db.prepare('SELECT control_action_key FROM feedback_routes WHERE route_key=?').get(key);
    if(prior&&prior.control_action_key!==control_action_key)throw new Error('Feedback already belongs to another dispatch');
    this.db.prepare('INSERT OR IGNORE INTO feedback_routes VALUES (?,?,?,?,?,?,?,?,?)')
      .run(key,repository,pr_number,head,owner_thread_id,task_id,JSON.stringify(item_keys),control_action_key,evidence_ref);
    return {recorded:true,route_key:key,repair_complete:false,native_send_performed:false};
  }
}
