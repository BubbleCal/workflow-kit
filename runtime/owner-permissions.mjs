import {DatabaseSync} from 'node:sqlite';
import {openSync,readSync,closeSync,readFileSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {join,resolve,relative,isAbsolute} from 'node:path';

export function creationPermissionRequirement(root) {
  const file=root&&join(root,'OWNER_CREATION_POLICY.json');
  if(!file||!existsSync(file))return null;
  const p=JSON.parse(readFileSync(file,'utf8')).new_chat_permissions;
  return p?.enabled===true&&p.actual_human_verified===true&&p.sandbox_mode==='danger-full-access'&&p.approval_policy==='never'
    ?{sandbox_mode:p.sandbox_mode,approval_policy:p.approval_policy,source_message_id:p.source_message_id}:null;
}

// Read only native turn contexts, never UI defaults or mutable thread summaries.
// Large command outputs are skipped while scanning, so long rollouts stay bounded.
export function readOwnerPermissions({thread_id,workspace,expected_turn_id,codex_home=process.env.CODEX_HOME||join(homedir(),'.codex')}) {
  if(!/^[0-9a-f-]{36}$/i.test(thread_id??''))throw new Error('Exact native owner UUID required');
  const files=readdirSync(codex_home).filter(f=>/^state_\d+\.sqlite$/.test(f)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
  if(!files.length)throw new Error('Native permission metadata unavailable');
  const db=new DatabaseSync(join(codex_home,files[0]),{readOnly:true});let row;
  try{row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(thread_id);}finally{db.close();}
  if(!row?.rollout_path)throw new Error('Native owner rollout unavailable');
  const path=realpathSync(row.rollout_path),home=realpathSync(codex_home),rel=relative(home,path);
  if(isAbsolute(rel)||rel.startsWith('..')||!['sessions','archived_sessions'].includes(rel.split(/[\\/]/)[0]))throw new Error('Native rollout must remain in this host session store');
  const fd=openSync(path,'r'),buffer=Buffer.alloc(65536),decoder=new StringDecoder('utf8');let line='',skip=false,session,context;
  const consume=()=>{
    if(!skip&&/"type"\s*:\s*"(?:session_meta|turn_context)"/.test(line.slice(0,250))){
      const item=JSON.parse(line);
      if(item.type==='session_meta')session=item.payload;
      if(item.type==='turn_context')context={...item.payload,recorded_at:item.timestamp};
    }
    line='';skip=false;
  };
  try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0){
    // JSON is UTF-8; context strings may cross a chunk boundary.
    const chunk=decoder.write(buffer.subarray(0,n));let start=0;
    for(let i=0;i<chunk.length;i++)if(chunk[i]==='\n'){if(!skip)line+=chunk.slice(start,i);consume();start=i+1;}
    if(!skip)line+=chunk.slice(start);
    if(line.length>1024*1024){if(/"type"\s*:\s*"(?:session_meta|turn_context)"/.test(line.slice(0,250)))throw new Error('Oversized native permission context');skip=true;line='';}
  }if(!skip)line+=decoder.end();if(line)consume();}finally{closeSync(fd);}
  if(session?.id!==thread_id||!context?.turn_id||resolve(context.cwd)!==resolve(workspace)||expected_turn_id&&context.turn_id!==expected_turn_id)
    throw new Error('Native permission owner, workspace or current turn mismatch');
  const full=context.approval_policy==='never'&&context.sandbox_policy?.type==='danger-full-access'&&
    (!context.permission_profile||context.permission_profile.type==='disabled');
  return {verified:full,thread_id,turn_id:context.turn_id,workspace:context.cwd,approval_policy:context.approval_policy,
    sandbox_policy:context.sandbox_policy,permission_profile_type:context.permission_profile?.type??null,
    recorded_at:context.recorded_at,evidence_ref:path,source:'native_rollout.turn_context',
    ...(full?{}:{reason:'effective_owner_permissions_mismatch',next:'Keep the existing created owner and setup receipt. Apply Full access through supported native settings, then verify a new actual turn; never recreate the chat or claim a prompt changes permissions.'})};
}
