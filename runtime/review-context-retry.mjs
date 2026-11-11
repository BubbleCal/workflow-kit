import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function initReviewAttempts(db){db.exec(`CREATE TABLE IF NOT EXISTS review_delivery_attempts (
 attempt_id TEXT PRIMARY KEY,action_key TEXT NOT NULL,owner TEXT,payload_digest TEXT NOT NULL,payload TEXT NOT NULL,
 outcome TEXT NOT NULL,receipt TEXT,error_class TEXT,claimed_at INTEGER,settled_at INTEGER,legacy_evidence TEXT);`);}
export function archiveReviewAttempt(db,row,{outcome,receipt,error_class,claimed_at,settled_at,legacy_evidence}={}){
 if(!['review_decision','pr_ready','slack_pr'].includes(row.kind)||!row.attempt_id)return;
 db.prepare('INSERT OR IGNORE INTO review_delivery_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.attempt_id,row.action_key,row.owner,row.digest,row.payload,outcome??JSON.parse(row.receipt??'{}').outcome??row.state,receipt??row.receipt,error_class??row.last_error,claimed_at??null,settled_at??null,legacy_evidence?JSON.stringify(legacy_evidence):null);
 if(outcome&&settled_at!==undefined)db.prepare('UPDATE review_delivery_attempts SET outcome=?,receipt=?,error_class=?,settled_at=? WHERE attempt_id=?').run(outcome,receipt,error_class,settled_at,row.attempt_id);
}
export function verifiedUnsentReviewRetry(control,row,input){
 const receipt=JSON.parse(row.receipt??'{}');
 if(row.attempts!==1||row.owner!==input.owner||row.attempt_id!==input.expected_attempt_id||row.last_error!=='rejected_before_send'||receipt.outcome!=='not_sent'||receipt.native_result||receipt.evidence_ref!==input.not_sent_proof_ref||
  control.db.prepare('SELECT 1 FROM review_send_permits WHERE action_key=?').get(row.action_key))return null;
 const prior=control.db.prepare('SELECT * FROM review_delivery_attempts WHERE attempt_id=?').get(row.attempt_id);
 if(prior&&prior.outcome!=='not_sent')return null;
 try{
  const bytes=readFileSync(input.not_sent_proof_ref),proof=JSON.parse(bytes),denialBytes=readFileSync(proof.authorize_ref),denial=JSON.parse(denialBytes),at=Date.parse(proof.checked_at);
  if(proof.action_key!==row.action_key||proof.task_id!==row.task_id||proof.attempt_id!==row.attempt_id||proof.native_send_invoked!==false||proof.operation_not_started!==true||
    !Number.isFinite(at)||at<row.created_at||at>control.now()+5000||denial.send!==false||!denial.reasons?.includes('reactive_plan_or_evidence_changed'))return null;
  return{proof_ref:input.not_sent_proof_ref,proof_digest:createHash('sha256').update(bytes).digest('hex'),denial_ref:proof.authorize_ref,denial_digest:createHash('sha256').update(denialBytes).digest('hex'),prior_attempt:row.attempt_id,original_checked_at:proof.checked_at};
 }catch{return null;}
}
