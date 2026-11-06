import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {Mailbox} from './mailbox.mjs';

// Renew an execution wait only from actual subsequent source observations. The
// source evidence expiry, task acceptance and action permissions are never extended.
export function renewVerifiedWaits({root,control,now=Date.now}) {
  const state=control.reactive,db=control.db,at=now();
  db.exec(`CREATE TABLE IF NOT EXISTS rt_wait_renewals (
    task_id TEXT,previous_updated_at INTEGER,renewed_at INTEGER,previous_expires_at INTEGER,
    expires_at INTEGER,proof TEXT,PRIMARY KEY(task_id,previous_updated_at));`);
  let mailbox;const renewed=[];
  try {
    for(const row of db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()) {
      const wait=JSON.parse(row.condition),task=state.task(row.task_id);
      if(wait.expires_at>at||!task||task.mode!=='active'||task.status!=='waiting'||task.dirty||state.openWake(row.task_id))continue;
      if(db.prepare("SELECT 1 FROM actions WHERE task_id=? AND kind NOT IN ('task_wake','task_queue') AND state IN ('claimed','uncertain')").get(row.task_id))continue;
      const facts=(wait.facts??[]).map(expected=>({expected,actual:db.prepare('SELECT * FROM rt_facts WHERE task_id=? AND subject=?').get(row.task_id,expected.subject)}));
      if(!facts.length||facts.some(({expected,actual})=>!actual||actual.version!==expected.version))continue;
      let expires=at+30*60000,condition={...wait.condition},proof;
      if(['pr','review_request'].includes(condition.kind)) {
        condition.next_check_at=new Date(expires).toISOString();
        const source=db.prepare('SELECT snapshot FROM lifecycle_prs WHERE pr_key=?').get(condition.pr_key??'');
        const snapshot=source?.snapshot?JSON.parse(source.snapshot):null,observed=Date.parse(snapshot?.checked_at);
        if(!Number.isFinite(observed)||observed<=row.updated_at||at-observed>20*60000)continue;
        proof=control.checkReactiveWait(condition);
      } else if(['dependency','access','job'].includes(condition.kind)) {
        const file=join(root,'mailbox.sqlite');if(!existsSync(file))continue;
        mailbox??=new Mailbox(file,{now});
        const source=mailbox.db.prepare('SELECT observed_at,expires_at,evidence_ref FROM wait_facts WHERE fact_key=?').get(condition.fact_key??'');
        if(!source||source.observed_at<=row.updated_at||source.expires_at<=at||at-source.observed_at>20*60000)continue;
        expires=Math.min(expires,source.expires_at);proof=mailbox.waits.check(condition);
      } else continue;
      if(!proof?.valid)continue;
      const next={...wait,condition,expires_at:expires};
      control.atomic(()=>{
        const changed=db.prepare("UPDATE rt_waits SET condition=?,updated_at=? WHERE task_id=? AND state='waiting' AND updated_at=?")
          .run(JSON.stringify(next),at,row.task_id,row.updated_at);
        if(!changed.changes)return;
        db.prepare('INSERT INTO rt_wait_renewals VALUES (?,?,?,?,?,?)').run(row.task_id,row.updated_at,at,wait.expires_at,expires,
          JSON.stringify({condition,reason:proof.reason,evidence:proof.evidence_ref??null,facts:facts.map(({actual})=>({subject:actual.subject,version:actual.version,checked_at:actual.checked_at,evidence_ref:actual.evidence_ref}))}));
        renewed.push(row.task_id);
      });
    }
    return renewed;
  } finally {mailbox?.close();}
}
