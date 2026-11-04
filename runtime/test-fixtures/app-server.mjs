import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';

const root=process.argv[2],behavior=process.argv[3];
let turn={id:'old-turn',status:'completed',items:[]};
const thread=()=>({id:'owner',projectId:process.argv[4]??'p',cwd:root,model:'inherited-model',reasoningEffort:'high',
  status:{type:turn.status==='inProgress'?'active':'idle'},turns:[]});
const respond=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);appendFileSync(join(root,'requests.jsonl'),JSON.stringify(message)+'\n');
  if(message.method==='initialized')return;
  if(message.method==='initialize')return respond(message.id,{platformFamily:'test'});
  if(message.method==='thread/read')return respond(message.id,{thread:thread()});
  if(message.method==='thread/resume')return respond(message.id,{thread:thread(),cwd:root,model:'inherited-model',reasoningEffort:'high',approvalPolicy:'on-request',sandbox:{type:'workspaceWrite'}});
  if(message.method==='thread/turns/list')return respond(message.id,{data:[turn],nextCursor:null});
  if(message.method==='thread/queue/list')return respond(message.id,{data:behavior==='queued'?[{id:'user-message'}]:[],nextCursor:null});
  if(message.method==='thread/backgroundTerminals/list') {
    if(behavior==='unknown-jobs')return process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Method not supported'}})+'\n');
    return respond(message.id,{data:[],nextCursor:null});
  }
  if(message.method==='turn/start') {
    turn={id:'new-turn',status:'inProgress',items:[{type:'userMessage',content:message.params.input}]};
    if(behavior==='disconnect-after-send')return process.exit(0);
    respond(message.id,{turn});
    process.stdout.write(JSON.stringify({method:'turn/started',params:{threadId:'owner',turn}})+'\n');return;
  }
  process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Unknown fixture method'}})+'\n');
});
