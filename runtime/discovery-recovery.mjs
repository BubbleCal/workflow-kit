export class DiscoveryRecovery {
 constructor(store){
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS discovery_source_gaps (
   batch_id TEXT,source_id TEXT,revision INTEGER,window_from INTEGER,window_to INTEGER,reason TEXT,state TEXT,created_at INTEGER,
   PRIMARY KEY(batch_id,source_id,revision));
   CREATE TABLE IF NOT EXISTS discovery_coverage_ranges (
   batch_id TEXT,source_id TEXT,revision INTEGER,window_from INTEGER,window_to INTEGER,completed_at INTEGER,
   PRIMARY KEY(batch_id,source_id,revision,window_from,window_to));
   CREATE TABLE IF NOT EXISTS discovery_repair_retries (
   batch_id TEXT,generation INTEGER,evidence_ref TEXT,requested_at INTEGER,state TEXT,PRIMARY KEY(batch_id,generation));`);
 }
 isolated(batchId,source){return !!this.db.prepare("SELECT 1 FROM discovery_source_gaps WHERE batch_id=? AND source_id=? AND revision=? AND state='open'").get(batchId,source.source_id,source.revision);}
 frontier(source){
  const end=this.db.prepare(`SELECT MAX(at) at FROM (
   SELECT MAX(window_to) at FROM discovery_coverage_ranges WHERE source_id=? AND revision=?
   UNION ALL SELECT MAX(window_to) at FROM discovery_source_gaps WHERE source_id=? AND revision=? AND state='open')`)
   .get(source.source_id,source.revision,source.source_id,source.revision).at;
  return Math.max(source.last_success_at??0,end??0)||null;
 }
 escalate(mailbox){
  const threshold=3;
  for(const row of this.db.prepare("SELECT id,snapshot FROM discovery_batches WHERE state='checkpointed'").all()){
   for(const saved of JSON.parse(row.snapshot).sources){
    const current=this.store.sources().find(s=>s.source_id===saved.source_id),health=current?.health&&JSON.parse(current.health);
    if(!current?.enabled||current.revision!==saved.revision||current.last_success_at>=Math.max(Date.parse(saved.window.to),...(saved.catchup_windows??[]).map(w=>Date.parse(w.window.to)))||!(health?.failure_streak>=threshold))continue;
    this.db.prepare("INSERT OR IGNORE INTO discovery_source_gaps VALUES (?,?,?,?,?,?,'open',?)")
     .run(row.id,saved.source_id,saved.revision,Date.parse(saved.window.from),Math.max(Date.parse(saved.window.to),...(saved.catchup_windows??[]).map(w=>Date.parse(w.window.to))),health.reason,this.store.now());
    mailbox.enqueue({key:`discovery-stalled:${row.id}:${saved.source_id}:${saved.revision}`,lane:'maintenance',kind:'workflow_recovery',payload:{
     event:'discovery_source_stalled',batch_id:row.id,source_id:saved.source_id,source_revision:saved.revision,failure_streak:health.failure_streak,
     reason:health.reason,evidence_ref:`control.sqlite#discovery_batches/${row.id}`,user_notification_required:false,
     instruction:'Repair this exact source checkpoint without discarding pages, observations or unresolved gaps. Use scoped followup streams and retry_checkpoint after a verified repair. Newer collection may proceed, but success watermark cannot cross an unread gap.'}});
   }
  }
 }
 requestRetry({batch_id,generation,evidence_ref}){
  if(!evidence_ref?.trim())throw new Error('Verified repair evidence required');
  return this.store.atomic(()=>{
   const b=this.store.batch(batch_id);if(!b||b.state!=='checkpointed'||b.generation!==generation)throw new Error('Exact checkpoint generation required; preserve a live owner');
   for(const s of b.snapshot.sources){const current=this.store.sources().find(x=>x.source_id===s.source_id);if(!current?.enabled||current.revision!==s.revision)throw new Error('Checkpoint source scope changed');}
   this.db.prepare("INSERT OR IGNORE INTO discovery_repair_retries VALUES (?,?,?,?,'pending')").run(batch_id,generation,evidence_ref,this.store.now());
   this.db.prepare('UPDATE discovery_batches SET next_at=? WHERE id=?').run(this.store.now(),batch_id);
   for(const s of b.snapshot.sources){
    const current=this.store.sources().find(x=>x.source_id===s.source_id),end=Math.max(Date.parse(s.window.to),...(s.catchup_windows??[]).map(w=>Date.parse(w.window.to)));
    if(current.last_success_at===null||current.last_success_at<end)this.db.prepare('UPDATE discovery_sources SET next_at=MIN(next_at,?) WHERE source_id=?').run(this.store.now(),s.source_id);
   }
   return {requested:true,batch_id,generation,minimum_start_interval_preserved:true};
  });
 }
 requested(batch){return !!this.db.prepare("SELECT 1 FROM discovery_repair_retries WHERE batch_id=? AND generation=? AND state='pending'").get(batch.id,batch.generation);}
 consumeRetry(batch){this.db.prepare("UPDATE discovery_repair_retries SET state='queued' WHERE batch_id=? AND generation=?").run(batch.id,batch.generation);}
 complete(source,batch){
  const current=this.store.sources().find(x=>x.source_id===source.source_id);
  const windows=[source.window,...(source.catchup_windows??[]).map(w=>w.window)];
  for(const w of windows)this.db.prepare('INSERT OR IGNORE INTO discovery_coverage_ranges VALUES (?,?,?,?,?,?)').run(batch.id,source.source_id,source.revision,Date.parse(w.from),Date.parse(w.to),this.store.now());
  const gaps=this.db.prepare("SELECT * FROM discovery_source_gaps WHERE source_id=? AND revision=? AND state='open'").all(source.source_id,source.revision);
  const ranges=this.db.prepare('SELECT * FROM discovery_coverage_ranges WHERE source_id=? AND revision=? ORDER BY window_from,window_to').all(source.source_id,source.revision);
  let point=current.last_success_at??Math.min(...ranges.map(r=>r.window_from),...gaps.map(g=>g.window_from));
  for(const r of ranges)if(r.window_from<=point)point=Math.max(point,r.window_to);
  this.db.prepare("UPDATE discovery_source_gaps SET state='resolved' WHERE source_id=? AND revision=? AND window_to<=?").run(source.source_id,source.revision,point);
  const remaining=gaps.filter(g=>g.window_to>point),latest=Math.max(...windows.map(w=>Date.parse(w.to)));
  const health=remaining.length?JSON.stringify({...JSON.parse(current.health??'{}'),coverage_gap:true,open_gaps:remaining.length,observed_frontier:latest}):null;
  const end=current.last_success_at===null&&point===Math.min(...gaps.map(g=>g.window_from))?null:point;
  this.db.prepare('UPDATE discovery_sources SET last_success_at=?,health=?,next_at=? WHERE source_id=?').run(end,health,this.store.nextSlot(latest,current.interval_ms),source.source_id);
 }
}
