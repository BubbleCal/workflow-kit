import {isSetupNotice} from './feedback-notice.mjs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const reviewSurface = reviews => (reviews??[]).map(r=>({id:String(r.database_id??r.id??''),body:String(r.body??''),state:r.state??null,
  commit_id:r.commit_id??null,submitted_at:r.submitted_at??null,login:r.user?.login??r.author?.login??null,user_id:r.user?.id??r.author?.id??null,
  app_id:r.app?.id??r.user?.app?.id??null})).sort((a,b)=>a.id.localeCompare(b.id));
export const reviewSurfaceDigest = reviews => hash(reviewSurface(reviews));
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); };
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now+5000 && now-Date.parse(at) <= 60000;
export function pullRequestIdentity(payload) {
  const value=payload?.pr_url??payload?.message;
  const match=typeof value==='string'&&value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/);
  return match?{repository:match[1],pr_number:Number(match[2])}:null;
}

export class ReviewFeedback {
  constructor(db,now=()=>Date.now()) {
    this.db=db;this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS feedback_snapshots(repository TEXT,pr_number INTEGER,head TEXT,checked_at TEXT,evidence_ref TEXT,PRIMARY KEY(repository,pr_number));
      CREATE TABLE IF NOT EXISTS feedback_items(item_key TEXT PRIMARY KEY,repository TEXT,pr_number INTEGER,data TEXT,digest TEXT);
      CREATE TABLE IF NOT EXISTS feedback_assessments(item_key TEXT,head TEXT,digest TEXT,disposition TEXT,reason TEXT,evidence_ref TEXT,validation_ref TEXT,PRIMARY KEY(item_key,head,digest));
      `);
    db.exec('CREATE TABLE IF NOT EXISTS feedback_source_versions(repository TEXT,pr_number INTEGER,head TEXT,checked_at TEXT,surface_digest TEXT,review_digest TEXT,PRIMARY KEY(repository,pr_number))');
  }
  ingest(snapshot) {
    const {repository,pr_number,head_sha,checked_at,evidence_ref}=snapshot;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository??'') || !Number.isSafeInteger(pr_number) || pr_number<1 || !/^[a-f0-9]{40,64}$/.test(head_sha??'')) throw new Error('Exact repository, PR and head are required');
    if (!fresh(checked_at,this.now()) || snapshot.head_before!==head_sha || snapshot.head_after!==head_sha) throw new Error('Fresh consistent-head feedback snapshot required');
    required(evidence_ref,'complete source evidence');
    const previous=this.db.prepare('SELECT checked_at FROM feedback_snapshots WHERE repository=? AND pr_number=?').get(repository,pr_number);
    if(previous && Date.parse(previous.checked_at)>Date.parse(checked_at))throw new Error('Out-of-order feedback snapshot; preserve newer evidence');
    for(const feed of ['reviews','review_comments','issue_comments','review_threads'])
      if(snapshot.complete?.[feed]!==true || !Array.isArray(snapshot[feed]))throw new Error(`Complete all-author ${feed} pagination is required`);
    const roots=new Map(snapshot.review_threads.flatMap(t=>(t.comments?.nodes??t.comments??[]).map(c=>[String(c.databaseId??c.database_id??c.id),t])));
    const items=[];
    for(const [kind,rows] of [['review',snapshot.reviews],['inline',snapshot.review_comments],['issue',snapshot.issue_comments]]) for(const raw of rows) {
      if(!String(raw.body??'').trim() && raw.state!=='CHANGES_REQUESTED')continue;
      const id=String(raw.database_id??raw.id??'');required(id,'source ID');
      const thread=kind==='inline'?roots.get(String(raw.in_reply_to_id??id)):null;
      const data={kind,id,node_id:raw.node_id??null,body:String(raw.body??''),author:raw.user?.login??raw.author?.login??null,
        review_state:kind==='review'?raw.state:null,source_head:kind==='review'?raw.commit_id??null:kind==='inline'?raw.original_commit_id??raw.commit_id??null:null,
        review_id:raw.pull_request_review_id?String(raw.pull_request_review_id):null,path:raw.path??null,url:raw.html_url??null,
        thread_id:thread?.id??null,is_resolved:thread?.isResolved??thread?.is_resolved??null,is_outdated:thread?.isOutdated??thread?.is_outdated??null};
      // Resolution/outdated flags are context, not proof that the reported behavior was fixed.
      const digest=hash([kind,id,data.body,data.author,data.review_state,data.source_head]);
      const key=`${repository}#${pr_number}:${kind}:${id}`;
      this.db.prepare('INSERT INTO feedback_items VALUES (?,?,?,?,?) ON CONFLICT(item_key) DO UPDATE SET data=excluded.data,digest=excluded.digest')
        .run(key,repository,pr_number,JSON.stringify(data),digest);items.push(key);
      if(kind==='review'&&isSetupNotice(data))this.db.prepare('INSERT OR IGNORE INTO feedback_assessments VALUES (?,?,?,?,?,?,?)')
        .run(key,head_sha,digest,'informational','Exact known Claude manual-review setup notice; no code finding',evidence_ref,null);
    }
    this.db.prepare('INSERT INTO feedback_snapshots VALUES (?,?,?,?,?) ON CONFLICT(repository,pr_number) DO UPDATE SET head=excluded.head,checked_at=excluded.checked_at,evidence_ref=excluded.evidence_ref')
      .run(repository,pr_number,head_sha,checked_at,evidence_ref);
    const surface={reviews:reviewSurface(snapshot.reviews),inline:snapshot.review_comments,issue:snapshot.issue_comments,threads:snapshot.review_threads};
    this.db.prepare('INSERT INTO feedback_source_versions VALUES (?,?,?,?,?,?) ON CONFLICT(repository,pr_number) DO UPDATE SET head=excluded.head,checked_at=excluded.checked_at,surface_digest=excluded.surface_digest,review_digest=excluded.review_digest').run(repository,pr_number,head_sha,checked_at,hash(surface),reviewSurfaceDigest(snapshot.reviews));
    return {recorded:true,items:items.length,...this.status(repository,pr_number)};
  }
  status(repository,pr_number) {
    const snapshot=this.db.prepare('SELECT * FROM feedback_snapshots WHERE repository=? AND pr_number=?').get(repository,pr_number);
    const items=this.db.prepare('SELECT * FROM feedback_items WHERE repository=? AND pr_number=? ORDER BY item_key').all(repository,pr_number).map(row=>{
      const data=JSON.parse(row.data),a=snapshot?this.db.prepare('SELECT * FROM feedback_assessments WHERE item_key=? AND head=? AND digest=?').get(row.item_key,snapshot.head,row.digest):null;
      return {key:row.item_key,digest:row.digest,...data,assessment:a??null};
    });
    return {snapshot:snapshot??null,items};
  }
  assess({repository,pr_number,head,decisions}) {
    const status=this.status(repository,pr_number);
    if(!status.snapshot||status.snapshot.head!==head)throw new Error('Feedback assessment head changed');
    for(const decision of decisions??[]) {
      const item=status.items.find(x=>x.key===decision.key);
      if(!item||item.digest!==decision.digest)throw new Error('Feedback source changed; reread before assessing');
      if(!['actionable','informational','addressed','not_applicable','needs_scope_decision'].includes(decision.disposition))throw new Error('Explicit semantic disposition required');
      required(decision.reason,'assessment reason');required(decision.evidence_ref,'assessment evidence');
      if(decision.current_code_relevance_verified!==true)throw new Error('Assess meaning and current-head applicability, not only review state or thread flags');
      if(decision.disposition==='addressed')required(decision.validation_ref,'current-head fix validation');
      this.db.prepare('INSERT INTO feedback_assessments VALUES (?,?,?,?,?,?,?) ON CONFLICT(item_key,head,digest) DO UPDATE SET disposition=excluded.disposition,reason=excluded.reason,evidence_ref=excluded.evidence_ref,validation_ref=excluded.validation_ref')
        .run(item.key,head,item.digest,decision.disposition,decision.reason,decision.evidence_ref,decision.validation_ref??null);
    }
    return this.gate(repository,pr_number,head);
  }
  gate(repository,pr_number,head) {
    const {snapshot,items}=this.status(repository,pr_number);
    if(!snapshot||snapshot.head!==head||!fresh(snapshot.checked_at,this.now()))return {allowed:false,reasons:['fresh_complete_review_feedback_required']};
    const unassessed=items.filter(x=>!x.assessment),blocking=items.filter(x=>['actionable','needs_scope_decision'].includes(x.assessment?.disposition));
    return {allowed:!unassessed.length&&!blocking.length,reasons:[...(unassessed.length?['review_feedback_unassessed']:[]),...(blocking.length?['material_review_feedback_open']:[])],unassessed:unassessed.map(x=>x.key),blocking:blocking.map(x=>x.key)};
  }
}
