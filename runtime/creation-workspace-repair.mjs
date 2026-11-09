import {verifyNativeBinding,nativeReadback} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';

// Project launch identity and the authorized product checkout are distinct.
// This repairs registration only, before the original created owner can run.
export function reconcileCreationWorkspace(control,input){
 const {task_id,owner_thread_id,creation_action_key,expected_revision,source_message_id,evidence_ref,actual_human_verified,native_proof,project_listing,human_authorization}=input;
 if(actual_human_verified!==true||!source_message_id||!evidence_ref)throw new Error('Actual scoped human registration-repair authority required');
 verifyFollowupAuthority(human_authorization,input);
 return control.atomic(()=>{
  const t=control.work.get(task_id),db=control.db,now=control.now();
  if(!t||t.state!=='accepted'||t.owner_thread_id||control.work.execution(task_id)||t.kind!=='work'||t.data.source?.review_only===true)
   throw new Error('Only an accepted unbound unstarted implementation task can reconcile creation workspace');
  const action=db.prepare("SELECT * FROM actions WHERE action_key=? AND kind='create_thread' AND state='sent'").get(creation_action_key);
  const setup=db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(creation_action_key);
  const request=db.prepare('SELECT * FROM work_owner_requests WHERE task_id=?').get(task_id);
  const payload=JSON.parse(action?.payload??'{}'),receipt=JSON.parse(action?.receipt??'{}'),placement=JSON.parse(setup?.placement??'{}');
  const native=receipt.native_result?.structuredContent??receipt.native_result?.content?.flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}}).find(c=>c.threadId);
  const project=control.work.config.scope.project_id,read=nativeReadback(native_proof?.readback),workspace=read.thread?.cwd;
  if(!action||action.task_id!==task_id||creation_action_key!==`owner-create:${t.canonical_key}`||request?.action_key!==creation_action_key||
    payload.canonical_task_key!==t.canonical_key||receipt.outcome!=='sent'||receipt.native_result?.isError===true||native?.threadId!==owner_thread_id||
    setup?.task_id!==task_id||setup.thread_id!==owner_thread_id||setup.state!=='complete'||setup.host_id!=='local'||placement.project_id!==project||
    payload.native?.target?.type!=='project'||payload.native.target.projectId!==project||!payload.native.prompt)
   throw new Error('Exact completed native creation, owner request and verified project setup required');
  const at=Date.parse(project_listing?.checked_at),listing=project_listing?.readback;
  let projects=listing?.projects;for(const c of listing?.content??[])if(c.type==='text'){try{projects=JSON.parse(c.text).projects;}catch{}}
  if(project_listing?.source!=='codex_app.list_projects'||!project_listing.evidence_ref||!Number.isFinite(at)||at>now+5000||now-at>60000||
    !projects?.some(p=>p.projectId===project&&p.hostId==='local'&&p.path===workspace))
   throw new Error('Fresh native project catalog must corroborate the actual launch directory');
  const membership=native_proof.active_listing,membershipAt=Date.parse(membership?.checked_at);
  let threads=membership?.readback?.threads;for(const c of membership?.readback?.content??[])if(c.type==='text'){try{threads=JSON.parse(c.text).threads;}catch{}}
  if(membership?.source!=='codex_app.list_threads'||membership.request?.mode!=='history'||membership.request?.archived!==false||
   !Number.isFinite(membershipAt)||membershipAt>now+5000||now-membershipAt>60000||
   !threads?.some(t=>t.id===owner_thread_id&&t.kind==='codex'&&t.hostId==='local'&&t.projectId===project&&t.cwd===workspace))
   throw new Error('Fresh original owner project membership required');
  verifyNativeBinding(native_proof,{thread_id:owner_thread_id,workspace,now});
  const expected=`<codex_delegation>\n  <source_thread_id>${action.owner}</source_thread_id>\n  <input>${payload.native.prompt}</input>\n</codex_delegation>`;
  const setupTurns=read.turns.filter(t=>(t.items??[]).some(i=>
   i.type==='userMessage'&&(i.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')===payload.native.prompt||
   action.owner&&i.type==='functionCallOutput'&&i.namespace==='codex_app'&&i.name==='create_thread'&&i.output?.truncated===false&&i.output.text===expected));
  if(setupTurns.length!==1||setupTurns[0].status!=='completed'||setupTurns[0].error||!Number.isFinite(setupTurns[0].startedAt)||setupTurns[0].startedAt*1000<action.created_at-1000)
   throw new Error('Exact original completed native creation setup proof required');
  if(db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','uncertain')").get(task_id))throw new Error('Reconcile unknown effects before changing registration');
  db.exec('CREATE TABLE IF NOT EXISTS creation_workspace_repairs (task_id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const previous=db.prepare('SELECT data FROM creation_workspace_repairs WHERE task_id=?').get(task_id);
  if(previous){const audit=JSON.parse(previous.data);if(audit.creation_action_key!==creation_action_key||audit.owner_thread_id!==owner_thread_id||t.data.workspace!==workspace||t.data.product_workspace!==audit.product_workspace)throw new Error('Creation workspace repair identity changed');return {reconciled:false,already_reconciled:true,task_id,workspace,product_workspace:t.data.product_workspace};}
  if(t.revision!==expected_revision||!t.data.workspace||t.data.workspace===workspace||t.data.product_workspace)throw new Error('Expected original accepted registration revision and differing launch workspace required');
  const data={...t.data,workspace,product_workspace:t.data.workspace};
  const audit={task_id,creation_action_key,owner_thread_id,source_message_id,evidence_ref,native_evidence_ref:native_proof.evidence_ref,project_evidence_ref:project_listing.evidence_ref,project_id:project,workspace,product_workspace:t.data.workspace,old_revision:t.revision,new_revision:t.revision+1,scope_unchanged:true};
  db.prepare('INSERT INTO creation_workspace_repairs VALUES (?,?,?)').run(task_id,JSON.stringify(audit),now);
  db.prepare('UPDATE work_items SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),now,task_id);
  return {reconciled:true,task_id,workspace,product_workspace:t.data.workspace,revision:t.revision+1,owner_bound:false,execution_started:false,scope_unchanged:true};
 });
}
