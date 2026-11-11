export function continuationPolicy(db){
 const row=db.prepare("SELECT data FROM work_rules WHERE key='continuous_authorized_work'").get();
 return row?JSON.parse(row.data):null;
}

export function ownerAutonomyPolicy(db){
 const row=db.prepare("SELECT data FROM work_rules WHERE key='owner_autonomy'").get();
 return row?JSON.parse(row.data):null;
}

export function validateOwnerDecision(db,task,{disposition,decision_request,progress}){
 if(!continuationPolicy(db)?.enabled||task.contract.service_lane)return;
 const ids=new Set(task.contract.requirements.map(r=>r.id));
 if(progress){
  if(!Array.isArray(progress.remaining_requirements)||progress.remaining_requirements.some(id=>!ids.has(id))||
   !progress.next_action?.trim()||!Array.isArray(progress.jobs)||!Array.isArray(progress.dependencies))
   throw new Error('Stage progress needs remaining contract requirements, a concrete next action, actual jobs and dependencies');
 }
 if(disposition!=='needs_decision')return;
 const r=decision_request;
 if(!r||!['authority','identity','scope','external_commitment','material_choice'].includes(r.kind)||r.scope!=='task'||
  !r.question?.trim()||!r.why_owner_cannot_decide?.trim()||!Array.isArray(r.blocked_requirements)||!r.blocked_requirements.length||
  r.blocked_requirements.some(id=>!ids.has(id))||!Array.isArray(r.evidence_refs)||!r.evidence_refs.length||r.evidence_refs.some(x=>!x?.trim())||
  !Array.isArray(r.independent_authorized_work)||r.independent_authorized_work.length||!progress||!progress.remaining_requirements.length)
  throw new Error('needs_decision requires a material human-only blocker for the remaining goal; continue independent authorized work and read OWNER_CONTINUATION.md');
 if(r.kind==='material_choice'&&(!Array.isArray(r.options)||r.options.length<2||r.options.some(x=>!x.choice?.trim()||!x.impact?.trim())))
  throw new Error('A material human choice needs distinct options and their actual consequences');
}

export function continuationAfterReport(work,task){
 if(!continuationPolicy(work.db)?.enabled||task.kind==='exploration'||task.data.source?.review_only||task.data.meeting_preparation)return {};
 return {goal_continuation:{report_is_not_goal_completion:true,next_operation:'Compare all accepted requirements: continue a bounded next step or record a verified job/dependency wait; complete only with whole-goal acceptance. Request a human choice only for a material unresolved boundary.',scope_unchanged:true}};
}

export function hasNewHumanInput(db,task){
 const decision=db.prepare("SELECT created_at FROM rt_decisions WHERE task_id=? AND disposition='needs_decision' ORDER BY created_at DESC LIMIT 1").get(task.task_id);
 return !!db.prepare("SELECT 1 FROM actions WHERE task_id=? AND kind='human_input' AND state='sent' AND created_at>? AND json_extract(payload,'$.intent') IN ('steering','correction')").get(task.task_id,decision?.created_at??task.updated_at??0);
}
