import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {hostname,homedir} from 'node:os';

const execute=promisify(execFile);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const messageDigest=text=>createHash('sha256').update(text).digest('hex');
export const queueHostFingerprint=()=>messageDigest(JSON.stringify([hostname(),homedir()]));

// This adapter submits to Codex's native queue. It never loads a thread, starts
// a turn, selects an app-server endpoint, changes permissions or handles approval.
export class NativeQueue {
  constructor({binary='codex',timeout_ms=15000,run=execute,now=()=>Date.now()}={}) {
    if(typeof binary!=='string'||!binary.trim())throw new Error('Native Codex executable is required');
    this.binary=binary;this.timeout=timeout_ms;this.run=run;this.now=now;
  }
  async probe() {
    const results=await Promise.allSettled([
      this.run(this.binary,['--version'],{timeout:this.timeout,maxBuffer:65536}),
      this.run(this.binary,['queue','--help'],{timeout:this.timeout,maxBuffer:65536}),
    ]);
    for(const r of results)if(r.status==='rejected')throw r.reason;
    const [version,help]=results.map(r=>r.value.stdout.trim());
    if(!/^codex-cli\s/.test(version)||!help.includes('--thread')||!help.includes('--message'))throw new Error('Installed CLI does not expose the native queue contract');
    return {cli_version:version,host_fingerprint:queueHostFingerprint(),queue_command_available:true,desktop_consumption_verified:false};
  }
  validate(threadId,message) {
    if(!uuid.test(threadId??''))throw new Error('Use a verified exact native thread UUID, never a title');
    if(typeof message!=='string'||!message.trim()||message.includes('\0')||Buffer.byteLength(message)>65536)
      throw new Error('A bounded UTF-8 native queue message is required');
  }
  async enqueue(threadId,message) {
    try{this.validate(threadId,message);}catch(error){error.not_sent=true;throw error;}
    const submitted_at=this.now();let result;
    try {
      // Fixed argv is intentional: no --resume, --remote, profile, cwd, model,
      // permission override, shell, app-server proxy, or alternate fallback.
      result=await this.run(this.binary,['queue','--thread',threadId,'--message',message],{timeout:this.timeout,maxBuffer:1024*1024});
    }catch(error){error.uncertain=true;throw error;}
    const lines=result.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
    const receipts=lines.map(line=>line.match(/^Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})\.$/i)).filter(Boolean);
    if(receipts.length!==1||!uuid.test(receipts[0][1])||receipts[0][2]!==threadId) {
      const error=new Error('Native queue returned no unique matching receipt; do not retry an unknown submission');error.uncertain=true;throw error;
    }
    return {queued:true,queue_id:receipts[0][1],thread_id:threadId,message_digest:messageDigest(message),
      submitted_at,accepted_at:this.now(),execution_verified:false};
  }
}

const userText=item=>(item.type==='userMessage'?item.content??[]:[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const finalText=turn=>(turn.items??[]).filter(i=>i.type==='agentMessage'&&i.phase==='final_answer').map(i=>i.text).join('\n');
export function nativeReadback(value) {
  if(value?.schemaVersion===1&&value.thread)return value;
  if(value?.structuredContent?.schemaVersion===1&&value.structuredContent.thread)return value.structuredContent;
  for(const item of value?.content??[])if(item.type==='text'){
    try{const parsed=JSON.parse(item.text);if(parsed?.schemaVersion===1&&parsed.thread)return parsed;}catch{}
  }
  throw new Error('Expected the actual native read_thread result or its tool envelope');
}

// Validate actual native read_thread exports, not a queue ACK or a mock transcript.
// The operator must obtain these exports through the desktop App's supported tools.
export function validateQueueCompatibility(evidence,probe) {
  if(evidence?.schema_version!==1||evidence.source!=='codex_app.read_thread'||evidence.cli_version!==probe.cli_version||
    evidence.host_fingerprint!==probe.host_fingerprint)throw new Error('Queue validation must match this host and installed CLI');
  const checked=Date.parse(evidence.checked_at);
  if(!Number.isFinite(checked)||checked>Date.now()+5000)throw new Error('Actual native verification time is required');
  const cases=[],queueIds=new Set();
  for(const name of ['idle','busy']) {
    const c=evidence.cases?.find(c=>c.name===name),r=c?.receipt,read=nativeReadback(c?.readback);
    if(!c||!r?.queued||r.execution_verified!==false||!uuid.test(r.queue_id??'')||!uuid.test(r.thread_id??'')||
      read?.schemaVersion!==1||read.thread?.kind!=='codex'||read.thread?.hostId!=='local'||read.thread.id!==r.thread_id||
      typeof c.message!=='string'||messageDigest(c.message)!==r.message_digest||!c.expected_reply||!Array.isArray(read.turns))
      throw new Error(`Missing authentic native ${name} queue evidence`);
    if(queueIds.has(r.queue_id))throw new Error('Idle and busy verification need distinct actual queue submissions');
    queueIds.add(r.queue_id);
    const matches=read.turns.filter(t=>(t.items??[]).some(i=>userText(i)===c.message));
    if(matches.length!==1||matches[0].status!=='completed'||matches[0].error||finalText(matches[0])!==c.expected_reply)
      throw new Error(`${name} queue message was not consumed exactly once with its expected result`);
    const turn=matches[0];
    if(!Number.isFinite(r.submitted_at)||!Number.isFinite(r.accepted_at)||r.accepted_at<r.submitted_at||
      !Number.isFinite(turn.startedAt)||!Number.isFinite(turn.completedAt)||turn.startedAt*1000+1000<r.submitted_at)
      throw new Error(`${name} queue timestamps do not establish submission before consumption`);
    const before=c.before;
    if(before?.thread?.id!==r.thread_id||!before.latestTurn?.id)throw new Error(`Missing native ${name} preflight`);
    if(name==='idle' && (before.thread.status?.type!=='idle'||before.latestTurn.status!=='completed'||turn.id===before.latestTurn.id))
      throw new Error('Idle queue consumption must start a distinct native turn');
    if(name==='busy') {
      const busy=read.turns.find(t=>t.id===before.latestTurn.id);
      if(before.thread.status?.type!=='active'||before.latestTurn.status!=='inProgress'||!busy||busy.status!=='completed'||busy.error||
        !c.busy_expected_reply||finalText(busy)!==c.busy_expected_reply||turn.id===busy.id||turn.startedAt<busy.completedAt||
        r.submitted_at<busy.startedAt*1000||r.submitted_at>busy.completedAt*1000+1000||
        busy.durationMs<(c.minimum_busy_ms??0))throw new Error('Busy queue must preserve the active turn and execute only afterward');
    }
    cases.push({name,passed:true,turn_id:turn.id});
  }
  return {verified:true,cli_version:probe.cli_version,host_fingerprint:probe.host_fingerprint,checked_at:evidence.checked_at,cases};
}

export function verifyExecutionProof(proof,{thread_id,workspace,prompt,now=Date.now(),terminal=false}) {
  const read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at);
  if(proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||now-at>60000||
    read?.thread?.id!==thread_id||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==workspace||!Array.isArray(read.turns))
    throw new Error('Fresh native desktop thread identity and workspace proof required');
  const matches=read.turns.filter(t=>(t.items??[]).some(i=>userText(i)===prompt));
  if(matches.length!==1||!matches[0].id||!terminal&&matches[0].error)throw new Error('The exact queued prompt must appear in one actual native turn');
  const turn=matches[0];
  if(terminal && !['completed','failed','interrupted'].includes(turn.status))throw new Error('Native turn is not terminal');
  if(!terminal && (turn.status!=='inProgress'||read.thread.status?.type!=='active'||read.turns[0]?.id!==turn.id))
    throw new Error('Only the current executing native turn can begin this wake');
  return {turn_id:turn.id,status:turn.status,evidence_ref:proof.evidence_ref??`native:${thread_id}:${turn.id}`};
}

export function verifyNativeBinding(proof,{thread_id,workspace,now=Date.now()}) {
  const read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at);
  const listing=proof?.active_listing,listingAt=Date.parse(listing?.checked_at);
  let entries=listing?.readback?.threads;
  if(!entries)for(const item of listing?.readback?.content??[])if(item.type==='text'){try{entries=JSON.parse(item.text).threads;}catch{}}
  const unloaded=read?.thread?.status?.type==='notLoaded'&&listing?.source==='codex_app.list_threads'&&listing?.request?.archived===false&&
    listing.request.mode==='history'&&Number.isFinite(listingAt)&&listingAt<=now+5000&&now-listingAt<=60000&&
    entries?.some(t=>t.id===thread_id&&t.kind==='codex'&&t.hostId==='local'&&t.cwd===workspace)&&
    ['completed','failed','interrupted'].includes(read.turns?.[0]?.status);
  if(proof?.source!=='codex_app.read_thread'||!Number.isFinite(at)||at>now+5000||now-at>60000||
    read?.thread?.id!==thread_id||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==workspace||
    !(['idle','active'].includes(read.thread.status?.type)||unloaded))
    throw new Error('Fresh desktop-tool identity/workspace readback is required for cutover');
  return {verified:true,thread_id,workspace,status:read.thread.status?.type};
}
