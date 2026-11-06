// Source refresh and owner events use separate databases. Replay a durable outbox
// so a crash cannot lose the only terminal transition, including legacy writers.
export function publishWaitObservations({mailbox,state}) {
  for(const row of mailbox.db.prepare("SELECT * FROM wait_observation_outbox WHERE state='pending' ORDER BY rowid").all()){
    const actual=JSON.parse(row.input);
    for(const wait of state.db.prepare("SELECT * FROM rt_waits WHERE state='waiting'").all()){
      if(JSON.parse(wait.condition).condition?.fact_key!==row.fact_key)continue;
      state.ingest({event_id:`wait-fact:${wait.task_id}:${row.event_key}`,task_id:wait.task_id,source:'typed_wait_source',subject:`wait-fact:${row.fact_key}`,
        type:'wait_fact_changed',observed_at:actual.observed_at,payload:actual.data,evidence_ref:actual.evidence_ref,debounce_ms:0});
    }
    mailbox.db.prepare("UPDATE wait_observation_outbox SET state='delivered' WHERE event_key=?").run(row.event_key);
  }
}
