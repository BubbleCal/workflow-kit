import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function result(value,key){
 if(value?.isError)throw Error('Actual native source read failed');
 if(value?.[key])return value;
 if(value?.structuredContent?.[key])return value.structuredContent;
 for(const c of value?.content??[]){if(c.type!=='text')continue;try{const v=JSON.parse(c.text);if(v?.[key])return v;}catch{}}
 throw Error('Complete native source evidence is required');
}

// Bind history to the original listing and the real provider page. Reading a
// human request supplies source context; it does not admit work or grant rights.
export function codexHistoryFollowup({source,parent,followup,observations,cursor,complete,next_cursor,evidence_ref,excluded_threads=[],now=Date.now()}){
 const id=followup.thread_id,host=followup.host_id,project=source.scope.project_id;
 if(!parent||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id??'')||host!==source.scope.host_id||host!=='local'||excluded_threads.includes(id))
  throw Error('Followup must reference an ordinary authorized Codex thread and its primary listing page');
 const listingBytes=readFileSync(parent.data.evidence_ref),listingProof=JSON.parse(listingBytes),request=listingProof.job?.req??listingProof.request;
 const args=request?.arguments??request;
 if(request?.tool&&request.tool!=='list_threads'||args?.mode!=='history'||args.source!=='codex'||args.hostId!==host||args.archived!==false)
  throw Error('Original Codex project listing request required');
 const listing=result(listingProof.readback,'threads'),listed=listing.threads.find(t=>t.id===id);
 if(listed?.kind!=='codex'||listed.hostId!==host||listed.projectId!==project||!listed.cwd)
  throw Error('Thread is outside the exact original Codex project listing');
 const historyBytes=readFileSync(evidence_ref),proof=JSON.parse(historyBytes),at=Date.parse(proof.checked_at),history=result(proof.readback,'thread'),page=history.page;
 if(proof.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||proof.request?.threadId!==id||proof.request.hostId!==host||
  (proof.request.cursor??null)!==cursor||history.thread.id!==id||history.thread.kind!=='codex'||history.thread.hostId!==host||history.thread.cwd!==listed.cwd||
  page?.order!=='newest_first'||page.hasMore!==(complete!==true)||(page.nextCursor??null)!==(next_cursor??null)||!Array.isArray(history.turns))
  throw Error('Exact native Codex history identity, cursor and provider coverage required');
 for(const o of observations){
  const human=history.turns.some(t=>t.items?.some(i=>(t.id===o.version||i.id===o.version)&&i.type==='userMessage'&&i.truncated!==true&&
   i.content?.some(c=>c.type==='text'&&c.text?.trim()&&!/^\s*(?:\[workflow-|<heartbeat>|<codex_delegation>)/.test(c.text))));
  if(o.item_key!==id||o.entity_key!==`codex:${id}`||o.url!==`codex://threads/${id}`||o.project_id!==project||o.scope_key!==project||!human)
   throw Error('Codex observation must match a real human turn in this exact scoped history page');
 }
 return {parent_page_key:parent.page_key,thread_id:id,host_id:host,stream_key:`history:${host}:${id}`,listing_digest:digest(listingBytes),history_digest:digest(historyBytes)};
}
